import { describe, expect, it } from "vitest";
import { SPEECH_ROLES, isSpeechProtocolId, SPEECH_PROTOCOL_PATTERN } from "./speech.js";

describe("speech adapter protocol ids", () => {
  it("accepts plugin-style ids and rejects junk", () => {
    expect(isSpeechProtocolId("pi.local_voice")).toBe(true);
    expect(isSpeechProtocolId("openai_audio")).toBe(true);
    expect(isSpeechProtocolId("OpenAI Audio")).toBe(false);
    expect(isSpeechProtocolId("")).toBe(false);
    expect(isSpeechProtocolId(42)).toBe(false);
  });

  it("keeps the frozen pattern and role list", () => {
    expect(SPEECH_PROTOCOL_PATTERN.test("a".repeat(64))).toBe(true);
    expect(SPEECH_PROTOCOL_PATTERN.test("a".repeat(65))).toBe(false);
    expect(SPEECH_ROLES).toEqual(["transcribe", "synthesize"]);
  });
});
