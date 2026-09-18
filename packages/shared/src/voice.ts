/**
 * Voice dictation contracts — local plugin transcription (ADR: local voice
 * plugin, superseding the Phase 1 cloud-STT path).
 *
 * Data path:
 *
 *   Renderer WebAudio capture (mono PCM 16 kHz)
 *     → preload IPC (`pi-desktop/voice/*`)
 *     → Electron main voice IPC (validation + plugin adapter lookup)
 *     → local-voice plugin process (`speech.handle`, Whisper-class ONNX model)
 *     → transcript back to the composer
 *
 * Transcription never touches the network: the plugin loads model weights from
 * its own on-disk model directory (downloaded ahead of time from the domains
 * its manifest declares) and fails closed when none is available. The renderer
 * never addresses a model source directly. The transcript is only composer
 * text; sending it still goes through the one existing `agent/prompt` path.
 */
import Type from "typebox";
import * as Value from "typebox/value";
import { ErrorCodes } from "./errors.js";

/** Hard cap on a single dictation recording (enforced renderer-side timer and IPC validation). */
export const VOICE_MAX_RECORDING_MS = 120_000;
/** Hard cap on one transcription payload in bytes (IPC validation). */
export const VOICE_MAX_AUDIO_BYTES = 20 * 1024 * 1024;
/** Dictation audio is mono 16-bit little-endian PCM at this sample rate. */
export const VOICE_PCM_SAMPLE_RATE = 16_000;
/** The only dictation payload the voice IPC accepts. */
export const VOICE_PREFERRED_MIME_TYPE = "audio/pcm;rate=16000";

/** `audio/pcm` with an explicit `rate` parameter — the local pipeline contract. */
export function isSupportedVoiceMimeType(mimeType: string): boolean {
  if (typeof mimeType !== "string" || mimeType.length > 64) return false;
  const [base, ...parameters] = mimeType.split(";");
  if (base.trim().toLowerCase() !== "audio/pcm") return false;
  const rate = parameters
    .map((parameter) => parameter.trim().toLowerCase())
    .find((parameter) => parameter.startsWith("rate="));
  if (!rate || rate !== `rate=${VOICE_PCM_SAMPLE_RATE}`) return false;
  return true;
}

/**
 * Protocol id the bundled local-voice plugin registers. Voice IPC routes
 * dictation to whichever plugin holds this protocol.
 */
export const LOCAL_VOICE_PROTOCOL = "pi.local_voice";

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
  /** Optional language hint forwarded to the local model. */
  language?: string;
};

export type VoiceTranscribeResponse = {
  requestId: string;
  text: string;
  detectedLanguage?: string;
};

/** Answer of `pi-desktop/voice/capabilities` — no secrets, only booleans/limits. */
export type VoiceCapabilities = {
  /** The local-voice plugin is enabled, its adapter is live, and a model is ready. */
  configured: boolean;
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
 * Trusted, persisted voice settings (AppSettings.voice). Transcription runs on
 * a local plugin model, so no endpoint, model id, or API key is configured
 * here; only dictation behavior preferences live in settings.
 */
export type VoiceSettings = {
  /** Optional language hint (BCP-47). */
  language?: string;
  /** Reserved for the future voice-control flow; no behavioral consumer yet. */
  autoSend?: boolean;
};

/** Clamp/strip an untrusted `AppSettings.voice` value; `undefined` when empty. */
export function normalizeVoiceSettings(input: unknown): VoiceSettings | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  const next: VoiceSettings = {};
  const language = typeof raw.language === "string" ? raw.language.trim() : "";
  if (language) {
    if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(language)) return undefined;
    next.language = language;
  }
  if (typeof raw.autoSend === "boolean") next.autoSend = raw.autoSend;
  return Object.keys(next).length > 0 ? next : undefined;
}
