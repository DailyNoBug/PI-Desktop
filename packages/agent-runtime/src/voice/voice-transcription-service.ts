/**
 * Sidecar-owned transcription service: one provider instance plus a registry
 * of in-flight requests so `voice.cancel` can abort a hung upload. The
 * registry is keyed by the renderer-generated `requestId`, which is validated
 * upstream (Electron main) before the call reaches the sidecar.
 */
import {
  OpenAICompatibleTranscriptionProvider,
  VoiceTranscriptionError,
  type VoiceTranscriptionAudio,
  type VoiceTranscriptionOptions,
  type VoiceTranscriptionProvider,
  type VoiceTranscriptionResult,
} from "./openai-compatible-stt.js";

export class VoiceTranscriptionService {
  private readonly provider: VoiceTranscriptionProvider;
  private readonly inflight = new Map<string, AbortController>();

  constructor(provider: VoiceTranscriptionProvider = new OpenAICompatibleTranscriptionProvider()) {
    this.provider = provider;
  }

  get pendingCount(): number {
    return this.inflight.size;
  }

  isCancelled(requestId: string): boolean {
    return this.inflight.get(requestId)?.signal.aborted === true;
  }

  async transcribe(
    requestId: string,
    audio: VoiceTranscriptionAudio,
    options: Omit<VoiceTranscriptionOptions, "signal">,
  ): Promise<VoiceTranscriptionResult> {
    if (this.inflight.has(requestId)) {
      throw new VoiceTranscriptionError(
        "CONFLICT",
        "voice transcription request id is already in flight",
      );
    }
    const controller = new AbortController();
    this.inflight.set(requestId, controller);
    try {
      return await this.provider.transcribe(audio, { ...options, signal: controller.signal });
    } finally {
      this.inflight.delete(requestId);
    }
  }

  /** Abort an in-flight transcription; `false` when the id is unknown or settled. */
  cancel(requestId: string): boolean {
    const controller = this.inflight.get(requestId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /** Abort every in-flight transcription (sidecar shutdown path). */
  cancelAll(): void {
    for (const controller of this.inflight.values()) controller.abort();
    this.inflight.clear();
  }
}
