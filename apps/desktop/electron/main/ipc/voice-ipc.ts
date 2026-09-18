/**
 * Voice dictation IPC domain — local plugin transcription (ADR: local voice
 * plugin, superseding the Phase 1 cloud-STT path).
 *
 * Channels:
 * - `pi-desktop/voice/capabilities` — booleans + limits, no secrets
 * - `pi-desktop/voice/transcribe`   — validated audio → local-voice plugin
 *                                     speech adapter (`speech.handle`)
 * - `pi-desktop/voice/cancel`       — renderer-side cancel acknowledgement
 *
 * Every channel is main-window-sender-only. Transcription runs entirely
 * inside the plugin's utility process on a locally stored Whisper-class ONNX
 * model; no endpoint is contacted and no API key exists on this path. Audio
 * crosses to the plugin as base64 (mono PCM 16 kHz) and lives only in memory.
 */
import { Buffer } from "node:buffer";
import {
  ErrorCodes,
  IPC,
  LOCAL_VOICE_PROTOCOL,
  VOICE_MAX_AUDIO_BYTES,
  VOICE_MAX_RECORDING_MS,
  VOICE_PREFERRED_MIME_TYPE,
  validateVoiceTranscribeRequest,
  type VoiceCapabilities,
  type VoiceTranscribeResponse,
} from "@pi-desktop/shared";
import type { PluginRuntime } from "../plugin-runtime";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

export type VoiceIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  getPlugins: () => PluginRuntime | null;
};

const VOICE_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * The local-voice plugin reports readiness over its management rpc. Any
 * failure (plugin disabled, unloaded, handler missing) simply means "not
 * configured" — the mic affordance stays hidden.
 */
async function isLocalVoiceReady(plugins: PluginRuntime): Promise<boolean> {
  try {
    const status = await plugins.runPluginRpc("pi.local-voice", "status") as {
      ready?: boolean;
    } | null;
    return status?.ready === true;
  } catch {
    return false;
  }
}

/** Register the voice IPC domain. */
export function registerVoiceIpc({
  registrar,
  getHost,
  getPlugins,
}: VoiceIpcDependencies): void {
  registrar.handleWithEvent(IPC.invoke.voiceCapabilities, async (event) => {
    registrar.assertMainWindowSender(event);
    const host = getHost();
    if (!host) {
      throw Object.assign(new Error("host unavailable"), {
        errorCode: ErrorCodes.HOST_UNAVAILABLE,
      });
    }
    const plugins = getPlugins();
    const ready = plugins ? await isLocalVoiceReady(plugins) : false;
    const capabilities: VoiceCapabilities = {
      configured: ready,
      maxRecordingMs: VOICE_MAX_RECORDING_MS,
      maxAudioBytes: VOICE_MAX_AUDIO_BYTES,
      preferredMimeType: VOICE_PREFERRED_MIME_TYPE,
    };
    return capabilities;
  });

  registrar.handleWithEvent(IPC.invoke.voiceTranscribe, async (event, input: unknown) => {
    registrar.assertMainWindowSender(event);
    const plugins = getPlugins();
    if (!plugins) {
      throw Object.assign(new Error("voice backend unavailable"), {
        errorCode: ErrorCodes.HOST_UNAVAILABLE,
      });
    }
    const validated = validateVoiceTranscribeRequest(input);
    if (!validated.ok) {
      throw Object.assign(new Error(validated.failure.message), {
        errorCode: validated.failure.code,
      });
    }
    const request = validated.value;
    const result = await plugins.runSpeechAdapter(
      { binding: { protocol: LOCAL_VOICE_PROTOCOL }, role: "transcribe" },
      {
        requestId: request.requestId,
        audio: Buffer.from(request.audio).toString("base64"),
        mimeType: request.mimeType,
        durationMs: request.durationMs,
        ...(request.language ? { language: request.language } : {}),
      },
    );
    if (result.kind !== "text") {
      throw Object.assign(new Error("local voice adapter returned no text"), {
        errorCode: ErrorCodes.VOICE_TRANSCRIPTION_FAILED,
      });
    }
    const response: VoiceTranscribeResponse = {
      requestId: request.requestId,
      text: result.text ?? "",
    };
    return response;
  });

  registrar.handleWithEvent(IPC.invoke.voiceCancel, async (event, requestId: unknown) => {
    registrar.assertMainWindowSender(event);
    if (typeof requestId !== "string" || !VOICE_REQUEST_ID_PATTERN.test(requestId)) {
      throw Object.assign(new Error("invalid voice requestId"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    // Local transcription is bounded by the adapter call budget; the renderer
    // cancels its own state machine and simply discards a late result.
    return { cancelled: false };
  });
}
