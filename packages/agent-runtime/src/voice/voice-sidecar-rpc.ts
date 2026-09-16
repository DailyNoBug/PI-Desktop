/**
 * Sidecar RPC surface for voice dictation: `voice.transcribe` and
 * `voice.cancel` (Phase 1 batch STT).
 *
 * Kept out of `sidecar.ts`'s dispatch body so the voice domain owns its own
 * validation and cancellation state. Audio crosses the stdio boundary as
 * base64 (NDJSON cannot carry binary); Electron main has already validated the
 * original payload, and the size cap is re-checked here as defense in depth.
 * The provider config (`baseUrl`/`model`/`apiKey`) arrives per call from main's
 * trusted settings + secret store and is never logged.
 */
import { Buffer } from "node:buffer";
import { VOICE_MAX_AUDIO_BYTES } from "@pi-desktop/shared";
import { VoiceTranscriptionError } from "./openai-compatible-stt.js";
import { VoiceTranscriptionService } from "./voice-transcription-service.js";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

let service: VoiceTranscriptionService | null = null;

function voiceService(): VoiceTranscriptionService {
  service ??= new VoiceTranscriptionService();
  return service;
}

/** Abort every in-flight transcription (sidecar shutdown path). */
export function disposeVoiceTranscription(): void {
  service?.cancelAll();
  service = null;
}

/**
 * Handle one voice RPC. Throws Error objects carrying `errorCode` so the
 * stdio JSON-RPC layer forwards a structured code to Electron main.
 */
export function handleVoiceRpc(method: string, params: any): Promise<unknown> {
  switch (method) {
    case "voice.transcribe":
      return transcribe(params);
    case "voice.cancel":
      return Promise.resolve({
        cancelled: voiceService().cancel(String(params?.requestId ?? "")),
      });
    default:
      return Promise.reject(
        Object.assign(new Error(`voice method not found: ${method}`), { rpcCode: -32601 }),
      );
  }
}

async function transcribe(params: any): Promise<unknown> {
  const requestId = String(params?.requestId ?? "");
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw Object.assign(new Error("invalid voice requestId"), {
      errorCode: "INVALID_ARGUMENT",
    });
  }
  const audio = Buffer.from(
    typeof params?.audioBase64 === "string" ? params.audioBase64 : "",
    "base64",
  );
  if (audio.byteLength === 0 || audio.byteLength > VOICE_MAX_AUDIO_BYTES) {
    throw Object.assign(
      new Error(`voice audio payload rejected (${audio.byteLength} bytes)`),
      { errorCode: "VOICE_PAYLOAD_TOO_LARGE" },
    );
  }
  const provider = (params?.provider ?? {}) as {
    baseUrl?: unknown;
    model?: unknown;
    apiKey?: unknown;
  };
  const baseUrl = typeof provider.baseUrl === "string" ? provider.baseUrl.trim() : "";
  const model = typeof provider.model === "string" ? provider.model.trim() : "";
  if (!baseUrl || !model) {
    throw Object.assign(new Error("voice STT provider not configured"), {
      errorCode: "VOICE_NOT_CONFIGURED",
    });
  }
  try {
    const result = await voiceService().transcribe(
      requestId,
      {
        data: new Uint8Array(audio),
        mimeType: String(params?.mimeType ?? "audio/webm"),
        durationMs: Number(params?.durationMs ?? 0) || 0,
        ...(typeof params?.language === "string" && params.language
          ? { language: params.language.slice(0, 16) }
          : {}),
      },
      {
        baseUrl,
        model,
        ...(typeof provider.apiKey === "string" && provider.apiKey
          ? { apiKey: provider.apiKey }
          : {}),
      },
    );
    return {
      requestId,
      text: result.text,
      ...(result.detectedLanguage ? { detectedLanguage: result.detectedLanguage } : {}),
    };
  } catch (error) {
    if (error instanceof VoiceTranscriptionError) {
      throw Object.assign(new Error(error.message), { errorCode: error.errorCode });
    }
    throw error;
  }
}
