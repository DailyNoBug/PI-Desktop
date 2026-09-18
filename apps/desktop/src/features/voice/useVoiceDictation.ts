/**
 * useVoiceDictation — composer-facing dictation hook (local plugin STT).
 *
 * Owns the microphone lifecycle: getUserMedia(audio) → WebAudio tap
 * (AudioWorklet, ScriptProcessor fallback) → mono 16 kHz PCM →
 * `pi-desktop/voice/transcribe` → the local-voice plugin's speech adapter →
 * transcript callback. Audio lives only in memory for the duration of the
 * request and is never persisted or logged. Exactly one recording may be
 * active app-wide (voice-singleton), bound to window/session/composer.
 *
 * All side-effectful collaborators are injectable so tests can drive the full
 * state machine without a microphone.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import {
  VOICE_MAX_AUDIO_BYTES,
  VOICE_MAX_RECORDING_MS,
  VOICE_PREFERRED_MIME_TYPE,
  type VoiceDictationSnapshot,
  type VoiceSessionBinding,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { INITIAL_VOICE_SNAPSHOT, reduceVoiceSnapshot } from "./voice-state";
import {
  claimVoiceSession,
  activeVoiceSession,
  releaseVoiceSession,
  sameVoiceBinding,
} from "./voice-singleton";
import { getUserMediaErrorName, toVoiceFailure } from "./voice-errors";
import { float32ToInt16Bytes } from "./pcm";
import { createPcmCapture, type PcmCapture, type PcmCaptureFactory } from "./pcm-capture";

/** DOM CustomEvent the global shortcut dispatcher emits to reach this hook. */
export const VOICE_DICTATION_TOGGLE_EVENT = "pi-desktop:voice-dictation-toggle";

export type UseVoiceDictationOptions = {
  composerId: string;
  sessionId: string | null;
  /** Language hint from trusted settings (AppSettings.voice.language). */
  language?: string;
  /** Mic affordance renders only when the local voice plugin is ready. */
  enabled: boolean;
  /** Receives the final transcript for insertion at the composer cursor. */
  onTranscript: (text: string) => void;
};

export type UseVoiceDictationResult = {
  snapshot: VoiceDictationSnapshot;
  busy: boolean;
  /** Primary entry: idle→record, recording→stop, transcribing→cancel. */
  toggle: () => void;
  cancel: () => void;
  /** Clear a `ready`/`error` snapshot back to idle. */
  dismiss: () => void;
};

/** Per-renderer-window identity for the singleton binding. */
const VOICE_WINDOW_ID = globalThis.crypto?.randomUUID
  ? globalThis.crypto.randomUUID()
  : `window-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

export function useVoiceDictation({
  composerId,
  sessionId,
  language,
  enabled,
  onTranscript,
}: UseVoiceDictationOptions): UseVoiceDictationResult {
  const [snapshot, dispatch] = useReducer(reduceVoiceSnapshot, INITIAL_VOICE_SNAPSHOT);
  const captureRef = useRef<PcmCapture | null>(null);
  const cancelRequestedRef = useRef(false);
  const startedAtRef = useRef<number | null>(null);
  const autoStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  const languageRef = useRef(language);
  onTranscriptRef.current = onTranscript;
  languageRef.current = language;

  const clearAutoStopTimer = useCallback(() => {
    if (autoStopTimerRef.current !== null) {
      clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }
  }, []);

  const releaseIfOwner = useCallback((binding: VoiceSessionBinding) => {
    releaseVoiceSession(binding);
    captureRef.current = null;
    cancelRequestedRef.current = false;
    startedAtRef.current = null;
  }, []);

  const handleCaptured = useCallback(
    async (binding: VoiceSessionBinding, capture: PcmCapture) => {
      clearAutoStopTimer();
      if (cancelRequestedRef.current) {
        releaseIfOwner(binding);
        dispatch({ type: "cancelled" });
        return;
      }
      let captured: { samples: Float32Array; sampleRate: number };
      try {
        captured = await capture.stop();
      } catch {
        captured = { samples: new Float32Array(0), sampleRate: 16000 };
      }
      if (cancelRequestedRef.current) {
        releaseIfOwner(binding);
        dispatch({ type: "cancelled" });
        return;
      }
      const bytes = float32ToInt16Bytes(captured.samples);
      const durationMs =
        startedAtRef.current !== null ? Math.max(1, Date.now() - startedAtRef.current) : 1;
      releaseIfOwner(binding);
      if (bytes.byteLength === 0) {
        dispatch({
          type: "failed",
          code: "INVALID_ARGUMENT",
          message: "recorded audio is empty",
        });
        return;
      }
      if (bytes.byteLength > VOICE_MAX_AUDIO_BYTES) {
        dispatch({
          type: "failed",
          code: "VOICE_PAYLOAD_TOO_LARGE",
          message: "recorded audio exceeds the payload limit",
        });
        return;
      }
      dispatch({ type: "audio-ready" });
      const requestId = globalThis.crypto?.randomUUID
        ? globalThis.crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      try {
        const result = await api.voiceTranscribe({
          requestId,
          audio: bytes,
          mimeType: VOICE_PREFERRED_MIME_TYPE,
          durationMs,
          ...(languageRef.current ? { language: languageRef.current } : {}),
        });
        dispatch({ type: "transcription-succeeded" });
        onTranscriptRef.current(result.text);
      } catch (error) {
        const failure = toVoiceFailure(error);
        if (failure.code === "VOICE_CANCELLED") {
          dispatch({ type: "cancelled" });
          return;
        }
        dispatch({
          type: "transcription-failed",
          code: failure.code,
          message: failure.message,
        });
      }
    },
    [clearAutoStopTimer, releaseIfOwner],
  );

  const start = useCallback(async () => {
    const binding: VoiceSessionBinding = {
      windowId: VOICE_WINDOW_ID,
      sessionId,
      composerId,
    };
    if (!claimVoiceSession(binding)) {
      dispatch({
        type: "failed",
        code: "CONFLICT",
        message: "another dictation is already active",
      });
      return;
    }
    dispatch({ type: "permission-requested", binding });
    try {
      const media = globalThis.navigator?.mediaDevices;
      if (!media?.getUserMedia) throw Object.assign(new Error("getUserMedia unavailable"), { name: "NotFoundError" });
      const stream = await media.getUserMedia({ audio: true });
      const capture = await createPcmCapture(stream);
      captureRef.current = capture;
      cancelRequestedRef.current = false;
      startedAtRef.current = Date.now();
      autoStopTimerRef.current = setTimeout(() => {
        // Hard stop at the cap: transition through `stopping` exactly like a
        // manual stop, so the captured audio is transcribed, not dropped.
        dispatch({ type: "stop-requested" });
        const active = captureRef.current;
        captureRef.current = null;
        if (active) {
          void handleCaptured(binding, active).catch(() => {
            releaseIfOwner(binding);
            dispatch({ type: "cancelled" });
          });
        } else {
          releaseIfOwner(binding);
          dispatch({ type: "cancelled" });
        }
      }, VOICE_MAX_RECORDING_MS);
    } catch (error) {
      releaseIfOwner(binding);
      const name = getUserMediaErrorName(error);
      if (
        name === "NotAllowedError" ||
        name === "SecurityError" ||
        name === "NotFoundError" ||
        name === "NotReadableError" ||
        name === "OverconstrainedError" ||
        name === "NotSupportedError"
      ) {
        dispatch({
          type: "permission-denied",
          message: error instanceof Error ? error.message : name,
        });
        return;
      }
      const failure = toVoiceFailure(error);
      dispatch({ type: "failed", code: failure.code, message: failure.message });
    }
  }, [composerId, handleCaptured, releaseIfOwner, sessionId]);

  const stop = useCallback(() => {
    const binding = snapshot.binding;
    if (!binding) return;
    dispatch({ type: "stop-requested" });
    const active = captureRef.current;
    captureRef.current = null;
    if (active) {
      void handleCaptured(binding, active).catch(() => {
        releaseIfOwner(binding);
        dispatch({ type: "cancelled" });
      });
      return;
    }
    releaseIfOwner(binding);
    dispatch({ type: "cancelled" });
  }, [handleCaptured, releaseIfOwner, snapshot.binding]);

  const cancel = useCallback(() => {
    const binding = snapshot.binding;
    if (!binding) return;
    cancelRequestedRef.current = true;
    const active = captureRef.current;
    if (active) {
      captureRef.current = null;
      active.abort();
    }
    releaseIfOwner(binding);
    dispatch({ type: "cancelled" });
  }, [releaseIfOwner, snapshot.binding]);

  const toggle = useCallback(() => {
    switch (snapshot.state) {
      case "idle":
      case "error":
      case "ready":
        void start();
        break;
      case "recording":
        stop();
        break;
      case "transcribing":
        cancel();
        break;
      default:
        break;
    }
  }, [cancel, snapshot.state, start, stop]);

  const dismiss = useCallback(() => {
    dispatch({ type: "reset" });
  }, []);

  // Global shortcut entry: only this hook's binding (or an idle registry)
  // answers, so two mounted composers cannot both start recording.
  useEffect(() => {
    if (!enabled) return;
    const onToggle = () => {
      const active = activeVoiceSession();
      if (active && !sameVoiceBinding(active, { windowId: VOICE_WINDOW_ID, sessionId, composerId })) {
        return;
      }
      toggle();
    };
    window.addEventListener(VOICE_DICTATION_TOGGLE_EVENT, onToggle);
    return () => window.removeEventListener(VOICE_DICTATION_TOGGLE_EVENT, onToggle);
  }, [composerId, enabled, sessionId, toggle]);

  // Unmount or session switch mid-recording must release the mic and slot.
  useEffect(() => {
    return () => {
      cancelRequestedRef.current = true;
      captureRef.current?.abort();
      captureRef.current = null;
      resetOnUnmount(sessionId, composerId);
    };
  }, [sessionId, composerId]);

  return useMemo(
    () => ({
      snapshot,
      busy:
        snapshot.state === "requesting-permission" ||
        snapshot.state === "recording" ||
        snapshot.state === "stopping" ||
        snapshot.state === "transcribing",
      toggle,
      cancel,
      dismiss,
    }),
    [cancel, dismiss, snapshot, toggle],
  );
}

function resetOnUnmount(sessionId: string | null, composerId: string) {
  const active = activeVoiceSession();
  if (
    active &&
    sameVoiceBinding(active, { windowId: VOICE_WINDOW_ID, sessionId, composerId })
  ) {
    releaseVoiceSession(active);
  }
}
