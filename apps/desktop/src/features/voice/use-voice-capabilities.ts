/**
 * Trusted-voice-capabilities reader: whether dictation is usable at all.
 * Booleans and limits only — the endpoint, model and especially the API key
 * never leave the main process.
 */
import { useEffect, useState } from "react";
import type { VoiceCapabilities } from "@pi-desktop/shared";
import { api } from "../../lib/api";

export type VoiceCapabilitiesState = {
  configured: boolean;
  loading: boolean;
};

const IDLE: VoiceCapabilitiesState = { configured: false, loading: true };

/**
 * `refreshKey` should be the persisted `AppSettings.voice` reference (or any
 * value that changes when the user edits voice settings) so the mic button
 * appears/disappears without an app restart.
 */
export function useVoiceCapabilities(refreshKey: unknown): VoiceCapabilitiesState {
  const [state, setState] = useState<VoiceCapabilitiesState>(IDLE);
  useEffect(() => {
    let cancelled = false;
    api
      .getVoiceCapabilities()
      .then((capabilities: VoiceCapabilities) => {
        if (!cancelled) {
          setState({ configured: capabilities.configured === true, loading: false });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ configured: false, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);
  return state;
}
