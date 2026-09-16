/**
 * Voice dictation contracts — Phase 1 batch transcription (ADR: voice
 * dictation).
 *
 * Data path:
 *
 *   Renderer MediaRecorder
 *     → preload IPC (`pi-desktop/voice/*`)
 *     → Electron main voice IPC (validation + trusted STT config)
 *     → Node agent sidecar (`voice.transcribe`)
 *     → OpenAI-compatible transcription endpoint
 *     → transcript back to the composer
 *
 * The renderer never addresses a transcription endpoint and never sees
 * provider credentials: main resolves the key from the host secret store
 * (`secrets.getForRuntime`) and hands it to the sidecar the same way
 * `agent.prompt` receives `provider.apiKey`. The transcript is only composer
 * text; sending it still goes through the one existing `agent/prompt` path.
 */
import Type from "typebox";
import * as Value from "typebox/value";
import { ErrorCodes } from "./errors.js";

/** Hard cap on a single dictation recording (enforced renderer-side timer and IPC validation). */
export const VOICE_MAX_RECORDING_MS = 120_000;
/** Hard cap on one transcription payload in bytes (IPC validation). */
export const VOICE_MAX_AUDIO_BYTES = 20 * 1024 * 1024;
/** Container types MediaRecorder may produce that the STT path accepts. */
export const VOICE_SUPPORTED_MIME_BASES = [
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
] as const;
/** Preferred capture mime type (Chromium/Electron default recorder). */
export const VOICE_PREFERRED_MIME_TYPE = "audio/webm;codecs=opus";
/** File extension per container for the multipart upload field. */
const MIME_EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
};

/** `audio/webm`, `audio/webm;codecs=opus`, ... — base type must be supported. */
export function isSupportedVoiceMimeType(mimeType: string): boolean {
  if (typeof mimeType !== "string" || mimeType.length > 64) return false;
  const base = mimeType.split(";", 1)[0].trim().toLowerCase();
  return (VOICE_SUPPORTED_MIME_BASES as readonly string[]).includes(base);
}

/** Upload filename extension for a supported mime type (`.webm` fallback). */
export function voiceAudioExtension(mimeType: string): string {
  const base = mimeType.split(";", 1)[0].trim().toLowerCase();
  return MIME_EXTENSIONS[base] ?? "webm";
}

/** Explicit dictation state machine; no conflicting booleans. */
export const VOICE_DICTATION_STATES = [
  "idle",
  "requesting-permission",
  "recording",
  "stopping",
  "transcribing",
  "ready",
  "error",
] as const;
export type VoiceDictationState = (typeof VOICE_DICTATION_STATES)[number];

export function isVoiceDictationState(value: unknown): value is VoiceDictationState {
  return (
    typeof value === "string" &&
    (VOICE_DICTATION_STATES as readonly string[]).includes(value)
  );
}

/** One active voice session is bound to a window/session/composer triple. */
export type VoiceSessionBinding = {
  windowId: string;
  sessionId: string | null;
  composerId: string;
};

/** Public dictation snapshot for UI + tests. */
export type VoiceDictationSnapshot = {
  state: VoiceDictationState;
  binding: VoiceSessionBinding | null;
  startedAt: number | null;
  durationMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export type VoiceTranscribeRequest = {
  requestId: string;
  /** Raw captured audio bytes; memory-only, never persisted. */
  audio: Uint8Array;
  mimeType: string;
  durationMs: number;
  /** Optional BCP-47 hint forwarded to the STT provider. */
  language?: string;
};

export type VoiceTranscribeResponse = {
  requestId: string;
  text: string;
  detectedLanguage?: string;
};

/** Answer of `pi-desktop/voice/capabilities` — no secrets, only booleans/limits. */
export type VoiceCapabilities = {
  configured: boolean;
  hasApiKey: boolean;
  maxRecordingMs: number;
  maxAudioBytes: number;
  preferredMimeType: string;
};

/**
 * Envelope schema validated at runtime. Binary audio cannot be expressed in
 * JSON schema, so the `audio` member is checked structurally beside it.
 */
export const VoiceTranscribeEnvelopeSchema = Type.Object({
  requestId: Type.String({
    minLength: 8,
    maxLength: 64,
    pattern: "^[A-Za-z0-9_-]+$",
  }),
  mimeType: Type.String({ minLength: 1, maxLength: 64 }),
  durationMs: Type.Integer({ minimum: 1, maximum: VOICE_MAX_RECORDING_MS }),
  language: Type.Optional(
    Type.String({ minLength: 2, maxLength: 16, pattern: "^[A-Za-z0-9-]*$" }),
  ),
});

export type VoiceValidationFailure = { code: string; message: string };

export type VoiceTranscribeValidation =
  | { ok: true; value: VoiceTranscribeRequest }
  | { ok: false; failure: VoiceValidationFailure };

/** Runtime validation for the transcribe IPC input (binary + envelope). */
export function validateVoiceTranscribeRequest(input: unknown): VoiceTranscribeValidation {
  if (!input || typeof input !== "object") {
    return {
      ok: false,
      failure: { code: ErrorCodes.INVALID_ARGUMENT, message: "voice transcribe input must be an object" },
    };
  }
  if (!Value.Check(VoiceTranscribeEnvelopeSchema, input)) {
    return {
      ok: false,
      failure: {
        code: ErrorCodes.INVALID_ARGUMENT,
        message: "voice transcribe envelope failed schema validation",
      },
    };
  }
  const { audio } = input as { audio?: unknown };
  if (!(audio instanceof Uint8Array)) {
    return {
      ok: false,
      failure: { code: ErrorCodes.INVALID_ARGUMENT, message: "voice audio must be a Uint8Array" },
    };
  }
  if (audio.byteLength === 0) {
    return {
      ok: false,
      failure: { code: ErrorCodes.INVALID_ARGUMENT, message: "voice audio payload is empty" },
    };
  }
  if (audio.byteLength > VOICE_MAX_AUDIO_BYTES) {
    return {
      ok: false,
      failure: {
        code: ErrorCodes.VOICE_PAYLOAD_TOO_LARGE,
        message: `voice audio payload exceeds ${VOICE_MAX_AUDIO_BYTES} bytes`,
      },
    };
  }
  const envelope = input as Omit<VoiceTranscribeRequest, "audio">;
  if (!isSupportedVoiceMimeType(envelope.mimeType)) {
    return {
      ok: false,
      failure: {
        code: ErrorCodes.INVALID_ARGUMENT,
        message: `unsupported voice audio mime type: ${envelope.mimeType.split(";")[0]}`,
      },
    };
  }
  return { ok: true, value: { ...envelope, audio } };
}

/**
 * Trusted, persisted voice settings (AppSettings.voice). Only non-secret
 * fields live here; the API key is stored under `VOICE_STT_SECRET_REF` in the
 * host secret store and never crosses to the renderer.
 */
export type VoiceSettings = {
  /** OpenAI-compatible transcription endpoint, e.g. `https://api.openai.com/v1`. */
  sttBaseUrl?: string;
  /** Transcription model id, e.g. `whisper-1` / `whisper-large-v3`. */
  sttModel?: string;
  /** Optional language hint (BCP-47). */
  language?: string;
  /** Phase 1 keeps default-off; the setting exists for the future voice-control flow. */
  autoSend?: boolean;
};

/** Secret-store reference for the voice STT API key. */
export const VOICE_STT_SECRET_REF = "voice/stt";

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    /^127\.\d+\.\d+\.\d+$/.test(hostname)
  );
}

/**
 * Accept `https://` endpoints anywhere and `http://` only on loopback, so a
 * local OpenAI-compatible Whisper works without opening plaintext LAN egress.
 */
export function isAllowedVoiceBaseUrl(baseUrl: string): boolean {
  if (typeof baseUrl !== "string" || baseUrl.length === 0 || baseUrl.length > 512) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol === "http:") return isLoopbackHostname(parsed.hostname);
  return false;
}

/** Clamp/strip an untrusted `AppSettings.voice` value; `undefined` when empty. */
export function normalizeVoiceSettings(input: unknown): VoiceSettings | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  const next: VoiceSettings = {};
  const baseUrl = typeof raw.sttBaseUrl === "string" ? raw.sttBaseUrl.trim() : "";
  if (baseUrl) {
    if (!isAllowedVoiceBaseUrl(baseUrl)) return undefined;
    next.sttBaseUrl = baseUrl.replace(/\/+$/, "");
  }
  const model = typeof raw.sttModel === "string" ? raw.sttModel.trim() : "";
  if (model) {
    if (model.length > 200) return undefined;
    next.sttModel = model;
  }
  const language = typeof raw.language === "string" ? raw.language.trim() : "";
  if (language) {
    if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(language)) return undefined;
    next.language = language;
  }
  if (typeof raw.autoSend === "boolean") next.autoSend = raw.autoSend;
  return Object.keys(next).length > 0 ? next : undefined;
}

/** A voice STT provider is configured when endpoint and model are present. */
export function isVoiceSttConfigured(settings: VoiceSettings | null | undefined): boolean {
  return Boolean(settings?.sttBaseUrl && settings?.sttModel);
}
