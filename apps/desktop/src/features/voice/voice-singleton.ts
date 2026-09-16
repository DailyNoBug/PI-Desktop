/**
 * App-wide active-recording registry (renderer process).
 *
 * Exactly one dictation may be active at a time, bound to a
 * window/session/composer triple, so two composers can never record
 * simultaneously and a stale session cannot hijack a new recording.
 */
import type { VoiceSessionBinding } from "@pi-desktop/shared";

let activeBinding: VoiceSessionBinding | null = null;

export function activeVoiceSession(): VoiceSessionBinding | null {
  return activeBinding;
}

export function sameVoiceBinding(
  a: VoiceSessionBinding,
  b: VoiceSessionBinding,
): boolean {
  return (
    a.windowId === b.windowId &&
    a.composerId === b.composerId &&
    a.sessionId === b.sessionId
  );
}

/** Claim the single recording slot; `false` when another composer holds it. */
export function claimVoiceSession(binding: VoiceSessionBinding): boolean {
  if (activeBinding) return false;
  activeBinding = binding;
  return true;
}

/** Release the slot, but only if this binding still owns it. */
export function releaseVoiceSession(binding: VoiceSessionBinding): void {
  if (activeBinding && sameVoiceBinding(activeBinding, binding)) {
    activeBinding = null;
  }
}

/** Force-clear (unmount cleanup, tests). */
export function resetVoiceSessionRegistry(): void {
  activeBinding = null;
}
