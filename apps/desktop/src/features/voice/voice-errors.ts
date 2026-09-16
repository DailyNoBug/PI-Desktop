/**
 * Voice dictation error mapping: structured codes → i18n keys, plus the
 * getUserMedia error-name classification. No raw provider payloads are ever
 * surfaced or logged.
 */

export function voiceErrorI18nKey(code: string | null): string {
  switch (code) {
    case "VOICE_MIC_PERMISSION_DENIED":
    case "NotAllowedError":
    case "SecurityError":
      return "chat.voice.micDenied";
    case "NotFoundError":
    case "NotReadableError":
    case "OverconstrainedError":
      return "chat.voice.micUnavailable";
    case "VOICE_PAYLOAD_TOO_LARGE":
      return "chat.voice.payloadTooLarge";
    case "VOICE_NOT_CONFIGURED":
      return "chat.voice.notConfigured";
    case "VOICE_CANCELLED":
      return "chat.voice.cancelled";
    case "PROVIDER_UNAUTHORIZED":
      return "chat.voice.unauthorized";
    case "PROVIDER_RATE_LIMITED":
      return "chat.voice.rateLimited";
    case "TIMEOUT":
      return "chat.voice.timeout";
    case "CONFLICT":
      return "chat.voice.busy";
    case "INVALID_ARGUMENT":
      return "chat.voice.invalidAudio";
    case "HOST_UNAVAILABLE":
      return "chat.voice.unavailable";
    default:
      return "chat.voice.transcriptionFailed";
  }
}

/** Extract a classifiable name out of a getUserMedia rejection. */
export function getUserMediaErrorName(error: unknown): string {
  if (error && typeof error === "object" && "name" in error) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && name) return name;
  }
  return "UNKNOWN";
}

/** Normalize any thrown value into a code/message pair for the state machine. */
export function toVoiceFailure(error: unknown): { code: string; message: string } {
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; message?: unknown };
    if (typeof candidate.code === "string" && typeof candidate.message === "string") {
      return { code: candidate.code, message: candidate.message };
    }
  }
  return {
    code: "VOICE_TRANSCRIPTION_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}
