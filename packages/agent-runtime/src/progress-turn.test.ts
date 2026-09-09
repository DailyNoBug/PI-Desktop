import { describe, expect, it } from "vitest";
import { isProgressOnlyAssistantTurn } from "./runtime";

describe("isProgressOnlyAssistantTurn", () => {
  it("detects visible text without tool calls", () => {
    expect(
      isProgressOnlyAssistantTurn({
        role: "assistant",
        content: [{ type: "text", text: "Staged YAML complete. Writing Owner Note now." }],
      }),
    ).toBe(true);
    expect(
      isProgressOnlyAssistantTurn({
        role: "assistant",
        content: "Writing the remaining note.",
      }),
    ).toBe(true);
  });

  it("does not flag tool-call turns", () => {
    expect(
      isProgressOnlyAssistantTurn({
        role: "assistant",
        content: [
          { type: "text", text: "Reading file" },
          { type: "toolCall", name: "Read", id: "t1" },
        ],
      }),
    ).toBe(false);
  });

  it("does not flag empty or thinking-only shapes", () => {
    expect(isProgressOnlyAssistantTurn({ role: "assistant", content: [] })).toBe(false);
    expect(
      isProgressOnlyAssistantTurn({
        role: "assistant",
        content: [{ type: "text", text: "   " }],
      }),
    ).toBe(false);
    expect(isProgressOnlyAssistantTurn(undefined)).toBe(false);
  });
});
