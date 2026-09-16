/**
 * Voice dictation IPC domain (Phase 1, ADR: voice dictation).
 *
 * Channels:
 * - `pi-desktop/voice/capabilities` — booleans + limits, no secrets
 * - `pi-desktop/voice/transcribe`   — validated audio → sidecar → STT
 * - `pi-desktop/voice/cancel`       — abort an in-flight transcription
 *
 * Every channel is main-window-sender-only. The STT endpoint/model come from
 * trusted settings and the API key is resolved from the host secret store
 * (`secrets.getForRuntime`) here in main — the renderer can neither choose an
 * arbitrary endpoint nor ever see the key. Audio crosses to the sidecar as
 * base64 because the sidecar protocol is NDJSON.
 */
import { Buffer } from "node:buffer";
import {
  ErrorCodes,
  IPC,
  VOICE_MAX_AUDIO_BYTES,
  VOICE_MAX_RECORDING_MS,
  VOICE_PREFERRED_MIME_TYPE,
  VOICE_STT_SECRET_REF,
  isVoiceSttConfigured,
  normalizeVoiceSettings,
  validateVoiceTranscribeRequest,
  type VoiceCapabilities,
  type VoiceSettings,
  type VoiceTranscribeResponse,
} from "@pi-desktop/shared";
import type { AgentSidecar } from "../agent-sidecar";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

export type VoiceIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  getSidecar: () => AgentSidecar | null;
};

const VOICE_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

async function loadVoiceConfig(
  host: HostProcess,
): Promise<{ settings: VoiceSettings | undefined; hasApiKey: boolean }> {
  const stored = await host
    .call<{ voice?: unknown } | null>("settings.get")
    .catch(() => null);
  const secret = await host
    .call<{ has?: boolean }>("secrets.has", { secretRef: VOICE_STT_SECRET_REF })
    .catch(() => ({ has: false }));
  return {
    settings: normalizeVoiceSettings(stored?.voice),
    hasApiKey: secret.has === true,
  };
}

/** Register the voice IPC domain. */
export function registerVoiceIpc({
  registrar,
  getHost,
  getSidecar,
}: VoiceIpcDependencies): void {
  registrar.handleWithEvent(IPC.invoke.voiceCapabilities, async (event) => {
    registrar.assertMainWindowSender(event);
    const host = getHost();
    if (!host) {
      throw Object.assign(new Error("host unavailable"), {
        errorCode: ErrorCodes.HOST_UNAVAILABLE,
      });
    }
    const { settings, hasApiKey } = await loadVoiceConfig(host);
    const capabilities: VoiceCapabilities = {
      configured: isVoiceSttConfigured(settings),
      hasApiKey,
      maxRecordingMs: VOICE_MAX_RECORDING_MS,
      maxAudioBytes: VOICE_MAX_AUDIO_BYTES,
      preferredMimeType: VOICE_PREFERRED_MIME_TYPE,
    };
    return capabilities;
  });

  registrar.handleWithEvent(IPC.invoke.voiceTranscribe, async (event, input: unknown) => {
    registrar.assertMainWindowSender(event);
    const host = getHost();
    const sidecar = getSidecar();
    if (!host || !sidecar) {
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
    const { settings, hasApiKey } = await loadVoiceConfig(host);
    if (!isVoiceSttConfigured(settings) || !settings?.sttBaseUrl || !settings?.sttModel) {
      throw Object.assign(new Error("voice STT provider is not configured"), {
        errorCode: ErrorCodes.VOICE_NOT_CONFIGURED,
      });
    }
    let apiKey: string | undefined;
    if (hasApiKey) {
      const secret = await host.call<{ value?: string }>("secrets.getForRuntime", {
        secretRef: VOICE_STT_SECRET_REF,
      });
      apiKey = secret.value || undefined;
    }
    const request = validated.value;
    const result = await sidecar.call<VoiceTranscribeResponse>("voice.transcribe", {
      requestId: request.requestId,
      audioBase64: Buffer.from(request.audio).toString("base64"),
      mimeType: request.mimeType,
      durationMs: request.durationMs,
      ...(request.language ? { language: request.language } : {}),
      provider: {
        baseUrl: settings.sttBaseUrl,
        model: settings.sttModel,
        ...(apiKey ? { apiKey } : {}),
      },
    });
    return result;
  });

  registrar.handleWithEvent(IPC.invoke.voiceCancel, async (event, requestId: unknown) => {
    registrar.assertMainWindowSender(event);
    if (typeof requestId !== "string" || !VOICE_REQUEST_ID_PATTERN.test(requestId)) {
      throw Object.assign(new Error("invalid voice requestId"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    const sidecar = getSidecar();
    if (!sidecar) return { cancelled: false };
    return sidecar.call<{ cancelled: boolean }>("voice.cancel", { requestId });
  });
}
