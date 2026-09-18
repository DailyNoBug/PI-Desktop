/**
 * Speech adapter contracts. Builtin cloud speech protocols are removed; the
 * only speech source is the plugin adapter registry
 * (`pi.speech.registerAdapter`, docs/spec/07-plugins/03-plugin-api.md).
 */

/** Roles a speech adapter can serve. */
export const SPEECH_ROLES = ["transcribe", "synthesize"] as const;
export type SpeechRole = (typeof SPEECH_ROLES)[number];

/** Wire identity for a plugin speech adapter. */
export const SPEECH_PROTOCOL_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

/** Validate a plugin-declared speech protocol id. */
export function isSpeechProtocolId(value: unknown): value is string {
  return typeof value === "string" && SPEECH_PROTOCOL_PATTERN.test(value);
}
