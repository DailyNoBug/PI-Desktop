import { describe, expect, it } from "vitest";
import * as Value from "typebox/value";
import {
  isAllowedVoiceBaseUrl,
  isSupportedVoiceMimeType,
  isVoiceSttConfigured,
  normalizeVoiceSettings,
  validateVoiceTranscribeRequest,
  VOICE_MAX_AUDIO_BYTES,
  VOICE_MAX_RECORDING_MS,
  VoiceTranscribeEnvelopeSchema,
} from "./voice.js";

function validRequest(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "req-12345678",
    audio: new Uint8Array([1, 2, 3, 4]),
    mimeType: "audio/webm;codecs=opus",
    durationMs: 1500,
    ...overrides,
  };
}

describe("voice transcribe request validation", () => {
  it("accepts a well-formed request", () => {
    const result = validateVoiceTranscribeRequest(validRequest());
    expect(result.ok).toBe(true);
  });

  it("rejects non-object input", () => {
    const result = validateVoiceTranscribeRequest(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("INVALID_ARGUMENT");
  });

  it("rejects a malformed envelope through the typebox schema", () => {
    expect(Value.Check(VoiceTranscribeEnvelopeSchema, {})).toBe(false);
    const result = validateVoiceTranscribeRequest(
      validRequest({ requestId: "x" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("INVALID_ARGUMENT");
  });

  it("rejects durations above the cap", () => {
    const result = validateVoiceTranscribeRequest(
      validRequest({ durationMs: VOICE_MAX_RECORDING_MS + 1 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("INVALID_ARGUMENT");
  });

  it("rejects audio that is not a Uint8Array", () => {
    const result = validateVoiceTranscribeRequest(
      validRequest({ audio: "not-bytes" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("INVALID_ARGUMENT");
  });

  it("rejects an empty payload", () => {
    const result = validateVoiceTranscribeRequest(
      validRequest({ audio: new Uint8Array(0) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("INVALID_ARGUMENT");
  });

  it("rejects an oversized payload with the structured voice code", () => {
    const oversized = new Uint8Array(VOICE_MAX_AUDIO_BYTES + 1);
    const result = validateVoiceTranscribeRequest(validRequest({ audio: oversized }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("VOICE_PAYLOAD_TOO_LARGE");
  });

  it("rejects unsupported mime types", () => {
    const result = validateVoiceTranscribeRequest(
      validRequest({ mimeType: "video/webm" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("INVALID_ARGUMENT");
  });

  it("accepts codec-parameterised supported mime types and optional language", () => {
    const result = validateVoiceTranscribeRequest(
      validRequest({ mimeType: "audio/ogg;codecs=opus", language: "zh-CN" }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("voice mime support", () => {
  it("accepts the containers MediaRecorder produces", () => {
    expect(isSupportedVoiceMimeType("audio/webm")).toBe(true);
    expect(isSupportedVoiceMimeType("audio/webm;codecs=opus")).toBe(true);
    expect(isSupportedVoiceMimeType("audio/ogg;codecs=opus")).toBe(true);
    expect(isSupportedVoiceMimeType("audio/mp4")).toBe(true);
  });

  it("refuses non-audio and malformed values", () => {
    expect(isSupportedVoiceMimeType("video/webm")).toBe(false);
    expect(isSupportedVoiceMimeType("")).toBe(false);
    expect(isSupportedVoiceMimeType("audio/whatever")).toBe(false);
  });
});

describe("voice base URL policy", () => {
  it("allows https endpoints anywhere", () => {
    expect(isAllowedVoiceBaseUrl("https://api.openai.com/v1")).toBe(true);
    expect(isAllowedVoiceBaseUrl("https://api.groq.com/openai/v1/")).toBe(true);
  });

  it("allows plain http only on loopback (local Whisper servers)", () => {
    expect(isAllowedVoiceBaseUrl("http://127.0.0.1:8080/v1")).toBe(true);
    expect(isAllowedVoiceBaseUrl("http://localhost:9000")).toBe(true);
    expect(isAllowedVoiceBaseUrl("http://192.168.1.5:8080/v1")).toBe(false);
    expect(isAllowedVoiceBaseUrl("http://api.openai.com/v1")).toBe(false);
  });

  it("refuses garbage", () => {
    expect(isAllowedVoiceBaseUrl("not a url")).toBe(false);
    expect(isAllowedVoiceBaseUrl("ftp://example.com")).toBe(false);
    expect(isAllowedVoiceBaseUrl("")).toBe(false);
  });
});

describe("voice settings normalization", () => {
  it("keeps valid fields and trims trailing slashes off the endpoint", () => {
    expect(
      normalizeVoiceSettings({
        sttBaseUrl: "https://api.openai.com/v1/",
        sttModel: "whisper-1",
        language: "en",
        autoSend: false,
      }),
    ).toEqual({
      sttBaseUrl: "https://api.openai.com/v1",
      sttModel: "whisper-1",
      language: "en",
      autoSend: false,
    });
  });

  it("drops unknown and empty input to undefined", () => {
    expect(normalizeVoiceSettings(undefined)).toBeUndefined();
    expect(normalizeVoiceSettings({})).toBeUndefined();
    expect(normalizeVoiceSettings("junk")).toBeUndefined();
  });

  it("rejects disallowed endpoints entirely", () => {
    expect(
      normalizeVoiceSettings({ sttBaseUrl: "http://lan-host/v1", sttModel: "m" }),
    ).toBeUndefined();
  });

  it("treats configured as endpoint+model only", () => {
    expect(isVoiceSttConfigured({ sttBaseUrl: "https://x.example/v1" })).toBe(false);
    expect(isVoiceSttConfigured({ sttModel: "whisper-1" })).toBe(false);
    expect(
      isVoiceSttConfigured({ sttBaseUrl: "https://x.example/v1", sttModel: "w" }),
    ).toBe(true);
  });
});
