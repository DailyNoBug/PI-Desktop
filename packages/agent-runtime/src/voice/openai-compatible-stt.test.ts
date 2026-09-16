import { describe, expect, it, vi } from "vitest";
import {
  OpenAICompatibleTranscriptionProvider,
  VoiceTranscriptionError,
} from "./openai-compatible-stt.js";
import { VoiceTranscriptionService } from "./voice-transcription-service.js";

const audio = () => ({
  data: new Uint8Array([1, 2, 3, 4]),
  mimeType: "audio/webm;codecs=opus",
  durationMs: 900,
});

const options = (overrides: Record<string, unknown> = {}) =>
  ({
    baseUrl: "https://stt.example/v1",
    model: "whisper-1",
    apiKey: "fixture-key",
    ...overrides,
  }) as Parameters<OpenAICompatibleTranscriptionProvider["transcribe"]>[1];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OpenAICompatibleTranscriptionProvider", () => {
  it("posts multipart to {baseUrl}/audio/transcriptions and parses text", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ text: "hello transcript", language: "en" }),
    );
    const provider = new OpenAICompatibleTranscriptionProvider(
      fetchImpl as unknown as typeof fetch,
    );
    const result = await provider.transcribe(audio(), options());
    expect(result).toEqual({
      text: "hello transcript",
      detectedLanguage: "en",
    });
     const [endpoint, init] = fetchImpl.mock.calls[0] as unknown as [
       string,
       RequestInit | undefined,
     ];
    expect(endpoint).toBe("https://stt.example/v1/audio/transcriptions");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer fixture-key",
    );
    const body = init?.body as FormData;
    expect(body.get("model")).toBe("whisper-1");
    expect(body.get("response_format")).toBe("json");
    expect((body.get("file") as File).name).toBe("dictation.webm");
  });

  it("maps 401 to PROVIDER_UNAUTHORIZED", async () => {
    const provider = new OpenAICompatibleTranscriptionProvider(
      vi.fn(async () => jsonResponse({ error: "bad key" }, 401)) as unknown as typeof fetch,
    );
    await expect(provider.transcribe(audio(), options())).rejects.toMatchObject({
      errorCode: "PROVIDER_UNAUTHORIZED",
    });
  });

  it("maps 429 to PROVIDER_RATE_LIMITED", async () => {
    const provider = new OpenAICompatibleTranscriptionProvider(
      vi.fn(async () => jsonResponse({}, 429)) as unknown as typeof fetch,
    );
    await expect(provider.transcribe(audio(), options())).rejects.toMatchObject({
      errorCode: "PROVIDER_RATE_LIMITED",
    });
  });

  it("maps a non-2xx to PROVIDER_ERROR with the status", async () => {
    const provider = new OpenAICompatibleTranscriptionProvider(
      vi.fn(async () => jsonResponse({}, 500)) as unknown as typeof fetch,
    );
    await expect(provider.transcribe(audio(), options())).rejects.toMatchObject({
      errorCode: "PROVIDER_ERROR",
      status: 500,
    });
  });

  it("rejects responses without text", async () => {
    const provider = new OpenAICompatibleTranscriptionProvider(
      vi.fn(async () => jsonResponse({ language: "en" })) as unknown as typeof fetch,
    );
    await expect(provider.transcribe(audio(), options())).rejects.toMatchObject({
      errorCode: "PROVIDER_ERROR",
    });
  });

  it("bounds a silent endpoint with TIMEOUT", async () => {
    const provider = new OpenAICompatibleTranscriptionProvider(
      vi.fn(
        (_endpoint: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ) as unknown as typeof fetch,
    );
    await expect(
      provider.transcribe(audio(), options({ timeoutMs: 25 })),
    ).rejects.toMatchObject({ errorCode: "TIMEOUT" });
  }, 5_000);

  it("reports external cancellation as VOICE_CANCELLED, not TIMEOUT", async () => {
    const external = new AbortController();
    const provider = new OpenAICompatibleTranscriptionProvider(
      vi.fn(
        (_endpoint: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
            setTimeout(() => external.abort(), 10);
          }),
      ) as unknown as typeof fetch,
    );
    await expect(
      provider.transcribe(audio(), options({ timeoutMs: 5_000, signal: external.signal })),
    ).rejects.toMatchObject({ errorCode: "VOICE_CANCELLED" });
  }, 5_000);

  it("maps a network failure to NETWORK_ERROR without leaking the key", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed somewhere");
    });
    const provider = new OpenAICompatibleTranscriptionProvider(
      fetchImpl as unknown as typeof fetch,
    );
    const error = await provider
      .transcribe(audio(), options())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VoiceTranscriptionError);
    expect((error as VoiceTranscriptionError).errorCode).toBe("NETWORK_ERROR");
    expect((error as Error).message).not.toContain("fixture-key");
  });
});

describe("VoiceTranscriptionService", () => {
  it("aborts an in-flight request through cancel()", async () => {
    const service = new VoiceTranscriptionService(
      new OpenAICompatibleTranscriptionProvider(
        vi.fn(
          (_endpoint: string, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () =>
                reject(new DOMException("aborted", "AbortError")),
              );
            }),
        ) as unknown as typeof fetch,
      ),
    );
    const pending = service.transcribe("cancel-me-01", audio(), {
      baseUrl: "https://stt.example/v1",
      model: "whisper-1",
    });
    expect(service.pendingCount).toBe(1);
    expect(service.cancel("cancel-me-01")).toBe(true);
    await expect(pending).rejects.toMatchObject({ errorCode: "VOICE_CANCELLED" });
    expect(service.pendingCount).toBe(0);
    expect(service.cancel("cancel-me-01")).toBe(false);
  });

  it("refuses a duplicate in-flight request id", async () => {
    const hanging = vi.fn(
      (_endpoint: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const service = new VoiceTranscriptionService(
      new OpenAICompatibleTranscriptionProvider(hanging as unknown as typeof fetch),
    );
    const first = service.transcribe("dup-id-00001", audio(), {
      baseUrl: "https://stt.example/v1",
      model: "whisper-1",
    });
    await expect(
      service.transcribe("dup-id-00001", audio(), {
        baseUrl: "https://stt.example/v1",
        model: "whisper-1",
      }),
    ).rejects.toMatchObject({ errorCode: "CONFLICT" });
    service.cancel("dup-id-00001");
    await expect(first).rejects.toMatchObject({ errorCode: "VOICE_CANCELLED" });
  });
});
