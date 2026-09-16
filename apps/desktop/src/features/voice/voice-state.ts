/**
 * Voice dictation state machine (pure; no React, no DOM).
 *
 * One explicit state instead of overlapping booleans. Every error path ends in
 * `error`, and `reset`/`cancelled` always return to `idle`, so a failed or
 * cancelled dictation can never leave the composer stuck.
 */
import type { VoiceDictationSnapshot, VoiceSessionBinding } from "@pi-desktop/shared";

export const INITIAL_VOICE_SNAPSHOT: VoiceDictationSnapshot = {
  state: "idle",
  binding: null,
  startedAt: null,
  durationMs: null,
  errorCode: null,
  errorMessage: null,
};

 export type VoiceAction =
   | { type: "permission-requested"; binding: VoiceSessionBinding }
   | { type: "permission-denied"; message: string }
  | { type: "recording-started"; startedAt: number }
  | { type: "stop-requested" }
  | { type: "audio-ready" }
  | { type: "transcription-succeeded" }
  | { type: "transcription-failed"; code: string; message: string }
  | { type: "failed"; code: string; message: string }
  | { type: "cancelled" }
  | { type: "reset" };

function errorSnapshot(
  previous: VoiceDictationSnapshot,
  code: string,
  message: string,
): VoiceDictationSnapshot {
  return {
    ...previous,
    state: "error",
    errorCode: code,
    errorMessage: message,
  };
}

/** Reduce one action; unknown combinations leave the state untouched. */
export function reduceVoiceSnapshot(
  state: VoiceDictationSnapshot,
  action: VoiceAction,
): VoiceDictationSnapshot {
  switch (action.type) {
    case "permission-requested":
      if (state.state !== "idle" && state.state !== "error") return state;
      return {
        ...INITIAL_VOICE_SNAPSHOT,
        state: "requesting-permission",
        binding: action.binding,
      };
    case "permission-denied":
      if (state.state !== "requesting-permission") return state;
      return errorSnapshot(
        { ...INITIAL_VOICE_SNAPSHOT },
        "VOICE_MIC_PERMISSION_DENIED",
        action.message,
      );
    case "recording-started":
      if (state.state !== "requesting-permission") return state;
      return { ...state, state: "recording", startedAt: action.startedAt };
    case "stop-requested":
      if (state.state !== "recording") return state;
      return { ...state, state: "stopping" };
    case "audio-ready":
      if (state.state !== "stopping") return state;
      return {
        ...state,
        state: "transcribing",
        durationMs:
          state.startedAt !== null ? Math.max(0, Date.now() - state.startedAt) : null,
      };
    case "transcription-succeeded":
      if (state.state !== "transcribing") return state;
      return { ...state, state: "ready", errorCode: null, errorMessage: null };
    case "transcription-failed":
      if (state.state !== "transcribing") return state;
      return errorSnapshot(state, action.code, action.message);
    case "failed":
      if (state.state === "idle") return state;
      return errorSnapshot(state, action.code, action.message);
    case "cancelled":
      if (state.state === "idle" || state.state === "ready" || state.state === "error") {
        return state;
      }
      return INITIAL_VOICE_SNAPSHOT;
    case "reset":
      return INITIAL_VOICE_SNAPSHOT;
  }
}
