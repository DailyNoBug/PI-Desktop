import { describe, expect, it } from "vitest";
import {
  VOICE_MAX_AUDIO_BYTES,
  VOICE_PREFERRED_MIME_TYPE,
  isSupportedVoiceMimeType,
  isVoiceDictationState,
  normalizeVoiceSettings,
  validateVoiceTranscribeRequest,
} from "./voice.js";

const validEnvelope = () => ({
  requestId: "req-12345678",
  mimeType: VOICE_PREFERRED_MIME_TYPE,
  durationMs: 1500,
});

describe("isSupportedVoiceMimeType", () => {
  it("accepts mono PCM at the dictation sample rate", () => {
    expect(isSupportedVoiceMimeType("audio/pcm;rate=16000")).toBe(true);
    expect(isSupportedVoiceMimeType("AUDIO/PCM;RATE=16000")).toBe(true);
  });

  it("rejects other containers and rates", () => {
    expect(isSupportedVoiceMimeType("audio/pcm;rate=48000")).toBe(false);
    expect(isSupportedVoiceMimeType("audio/pcm")).toBe(false);
    expect(isSupportedVoiceMimeType("audio/webm;codecs=opus")).toBe(false);
    expect(isSupportedVoiceMimeType("")).toBe(false);
    expect(isSupportedVoiceMimeType(42 as unknown as string)).toBe(false);
  });
});

describe("isVoiceDictationState", () => {
  it("accepts only known states", () => {
    expect(isVoiceDictationState("transcribing")).toBe(true);
    expect(isVoiceDictationState("rewinding")).toBe(false);
  });
});

describe("validateVoiceTranscribeRequest", () => {
  const pcm = new Uint8Array(16);

  it("accepts a PCM dictation payload", () => {
    const result = validateVoiceTranscribeRequest({ ...validEnvelope(), audio: pcm });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.mimeType).toBe("audio/pcm;rate=16000");
      expect(result.value.audio).toBe(pcm);
    }
  });

  it("forwards an optional language hint", () => {
    const result = validateVoiceTranscribeRequest({
      ...validEnvelope(),
      language: "zh-CN",
      audio: pcm,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.language).toBe("zh-CN");
  });

  it("rejects junk envelopes and payloads", () => {
    expect(validateVoiceTranscribeRequest(null).ok).toBe(false);
    expect(validateVoiceTranscribeRequest({ ...validEnvelope(), audio: "pcm" }).ok).toBe(false);
    expect(validateVoiceTranscribeRequest({ ...validEnvelope(), audio: new Uint8Array(0) }).ok).toBe(
      false,
    );
    expect(
      validateVoiceTranscribeRequest({ ...validEnvelope(), mimeType: "audio/webm", audio: pcm }).ok,
    ).toBe(false);
    expect(
      validateVoiceTranscribeRequest({ ...validEnvelope(), requestId: "short", audio: pcm }).ok,
    ).toBe(false);
    const oversized = new Uint8Array(VOICE_MAX_AUDIO_BYTES + 1);
    expect(validateVoiceTranscribeRequest({ ...validEnvelope(), audio: oversized }).ok).toBe(false);
  });
});

describe("normalizeVoiceSettings", () => {
  it("keeps dictation preferences", () => {
    expect(normalizeVoiceSettings({ language: "zh-CN", autoSend: false })).toEqual({
      language: "zh-CN",
      autoSend: false,
    });
    expect(normalizeVoiceSettings(undefined)).toBeUndefined();
    expect(normalizeVoiceSettings({})).toBeUndefined();
    expect(normalizeVoiceSettings("junk")).toBeUndefined();
    expect(normalizeVoiceSettings({ language: "not a language!" })).toBeUndefined();
  });

  it("ignores legacy cloud STT fields from earlier builds", () => {
    expect(normalizeVoiceSettings({ sttBaseUrl: "https://x.example/v1", sttModel: "whisper-1" })).toBeUndefined();
    expect(
      normalizeVoiceSettings({ sttBaseUrl: "https://x.example/v1", language: "en" }),
    ).toEqual({ language: "en" });
  });
});
