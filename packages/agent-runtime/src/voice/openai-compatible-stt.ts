/**
 * Voice transcription provider abstraction (Phase 1, batch STT).
 *
 * Deliberately independent of the coding-model provider system: the agent may
 * run on Anthropic while dictation uses any OpenAI-compatible transcription
 * endpoint (OpenAI, Groq Whisper, a local Whisper server, ...). Credentials
 * arrive per call from Electron main — resolved out of the host secret store —
 * exactly like `agent.prompt` receives `provider.apiKey`; this module never
 * reads settings or secrets itself and never logs either.
 */
import { voiceAudioExtension } from "@pi-desktop/shared";

export type VoiceTranscriptionAudio = {
  /** Raw in-memory audio bytes; never persisted anywhere. */
  data: Uint8Array;
  mimeType: string;
  durationMs: number;
  /** Optional BCP-47 language hint. */
  language?: string;
};

export type VoiceTranscriptionOptions = {
  /** OpenAI-compatible base URL, trusted config from Electron main. */
  baseUrl: string;
  model: string;
  /** Resolved API key; absent for keyless local endpoints. */
  apiKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type VoiceTranscriptionResult = {
  text: string;
  detectedLanguage?: string;
};

export interface VoiceTranscriptionProvider {
  readonly id: string;
  transcribe(
    audio: VoiceTranscriptionAudio,
    options: VoiceTranscriptionOptions,
  ): Promise<VoiceTranscriptionResult>;
}

export class VoiceTranscriptionError extends Error {
  readonly errorCode: string;
  readonly status?: number;
  constructor(errorCode: string, message: string, status?: number) {
    super(message);
    this.name = "VoiceTranscriptionError";
    this.errorCode = errorCode;
    this.status = status;
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Abort a target controller when either the caller's signal or the timeout
 * fires, without assuming `AbortSignal.any` availability.
 */
function linkAbortSignals(
  timeoutMs: number,
  external: AbortSignal | undefined,
): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : undefined;
  external?.addEventListener("abort", onExternalAbort, { once: true });
  if (external?.aborted) controller.abort();
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      if (timer !== undefined) clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    },
  };
}

/** POST `{baseUrl}/audio/transcriptions` (OpenAI-compatible multipart). */
export class OpenAICompatibleTranscriptionProvider implements VoiceTranscriptionProvider {
  readonly id = "openai-compatible";
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(fetchImpl: typeof globalThis.fetch = globalThis.fetch.bind(globalThis)) {
    this.fetchImpl = fetchImpl;
  }

  async transcribe(
    audio: VoiceTranscriptionAudio,
    options: VoiceTranscriptionOptions,
  ): Promise<VoiceTranscriptionResult> {
    const base = options.baseUrl.replace(/\/+$/, "");
    const endpoint = `${base}/audio/transcriptions`;
    const form = new FormData();
    const extension = voiceAudioExtension(audio.mimeType);
    form.append(
      "file",
      new Blob([audio.data as BlobPart], { type: audio.mimeType }),
      `dictation.${extension}`,
    );
    form.append("model", options.model);
    form.append("response_format", "json");
    if (audio.language) form.append("language", audio.language);

    const linked = linkAbortSignals(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.signal);
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: options.apiKey
          ? { Authorization: `Bearer ${options.apiKey}` }
          : undefined,
        body: form,
        signal: linked.signal,
      });
    } catch (error) {
      linked.cleanup();
      if (options.signal?.aborted) {
        throw new VoiceTranscriptionError(
          "VOICE_CANCELLED",
          "voice transcription cancelled",
        );
      }
      if (linked.timedOut()) {
        throw new VoiceTranscriptionError("TIMEOUT", "voice transcription request timed out");
      }
      throw new VoiceTranscriptionError(
        "NETWORK_ERROR",
        `voice transcription request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    linked.cleanup();

    if (response.status === 401 || response.status === 403) {
      throw new VoiceTranscriptionError(
        "PROVIDER_UNAUTHORIZED",
        "voice transcription endpoint rejected the credential",
        response.status,
      );
    }
    if (response.status === 429) {
      throw new VoiceTranscriptionError(
        "PROVIDER_RATE_LIMITED",
        "voice transcription endpoint rate limited the request",
        response.status,
      );
    }
    if (!response.ok) {
      throw new VoiceTranscriptionError(
        "PROVIDER_ERROR",
        `voice transcription endpoint returned HTTP ${response.status}`,
        response.status,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new VoiceTranscriptionError(
        "PROVIDER_ERROR",
        "voice transcription endpoint returned invalid JSON",
        response.status,
      );
    }
    const record = (payload ?? {}) as { text?: unknown; language?: unknown };
    if (typeof record.text !== "string") {
      throw new VoiceTranscriptionError(
        "PROVIDER_ERROR",
        "voice transcription response is missing text",
        response.status,
      );
    }
    const text = record.text;
    if (text.length > 100_000) {
      throw new VoiceTranscriptionError(
        "PROVIDER_ERROR",
        "voice transcription response text is unreasonably large",
        response.status,
      );
    }
    return {
      text,
      ...(typeof record.language === "string" && record.language
        ? { detectedLanguage: record.language.slice(0, 16) }
        : {}),
    };
  }
}
