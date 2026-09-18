import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_WEB_SEARCH_TOOL_TYPE,
  apiStyleSupportsNativeWebSearch,
  attachNativeWebSearchToPayload,
  extractHostedSearchFromAssistantContent,
  isHiddenNativeWebToolName,
  mergeHostedSearch,
  parseHostedSearchStreamEvent,
  supportsNativeWebSearch,
  wireApiSupportsNativeWebSearch,
} from "./native-web-search.js";




describe("native web search detection", () => {
  it("allows Anthropic Messages and OpenAI Responses wire APIs", () => {
    expect(wireApiSupportsNativeWebSearch("anthropic-messages")).toBe(true);
    expect(wireApiSupportsNativeWebSearch("openai-responses")).toBe(true);
    expect(apiStyleSupportsNativeWebSearch("anthropic_messages")).toBe(true);
    expect(apiStyleSupportsNativeWebSearch("responses")).toBe(true);
  });

  it("rejects Chat Completions and unknown custom styles", () => {
    expect(wireApiSupportsNativeWebSearch("openai-completions")).toBe(false);
    expect(apiStyleSupportsNativeWebSearch("chat_completions")).toBe(false);
    expect(apiStyleSupportsNativeWebSearch("opencode_go")).toBe(false);
    expect(apiStyleSupportsNativeWebSearch(undefined)).toBe(false);
  });

  it("does not infer support from a model-shaped name", () => {
    expect(apiStyleSupportsNativeWebSearch("claude-sonnet-4")).toBe(false);
    expect(wireApiSupportsNativeWebSearch("gpt-5")).toBe(false);
  });
});

describe("attachNativeWebSearchToPayload", () => {
  it("appends Anthropic's stable GA web_search tool", () => {
    const next = attachNativeWebSearchToPayload(
      { model: "claude-sonnet-4", tools: [{ name: "Read" }] },
      "anthropic-messages",
    );
    expect(next).toEqual({
      model: "claude-sonnet-4",
      tools: [
        { name: "Read" },
        { type: ANTHROPIC_WEB_SEARCH_TOOL_TYPE, name: "web_search" },
      ],
    });
  });

  it("appends OpenAI Responses web_search without duplicating it", () => {
    const first = attachNativeWebSearchToPayload({ tools: [] }, "openai-responses");
    const second = attachNativeWebSearchToPayload(first, "openai-responses");
    expect(second).toEqual({ tools: [{ type: "web_search" }] });
  });

  it("leaves Chat Completions payloads unchanged", () => {
    const payload = { model: "gpt-4o", tools: [] };
    expect(attachNativeWebSearchToPayload(payload, "openai-completions")).toBe(payload);
  });
});

describe("hidden native web tools", () => {
  it("recognizes leaked vendor search and fetch names", () => {
    expect(isHiddenNativeWebToolName("web_search")).toBe(true);
    expect(isHiddenNativeWebToolName("web_search_20250305")).toBe(true);
    expect(isHiddenNativeWebToolName("web_fetch")).toBe(true);
    expect(isHiddenNativeWebToolName("Read")).toBe(false);
  });
});

describe("extractHostedSearchFromAssistantContent", () => {
  it("reads query and sources from a leaked web_search tool call", () => {
    const search = extractHostedSearchFromAssistantContent([
      {
        type: "toolCall",
        name: "web_search",
        arguments: {
          query: "pi-desktop native search",
          sources: [
            { title: "Docs", url: "https://example.com/docs" },
            { url: "https://example.com/docs" },
          ],
        },
      },
    ]);
    expect(search?.queries).toEqual(["pi-desktop native search"]);
    expect(search?.sources).toEqual([{ url: "https://example.com/docs", title: "Docs" }]);
    expect(search?.status).toBe("completed");
  });

  it("merges later sources onto an in-progress search", () => {
    const merged = mergeHostedSearch(
      { status: "searching", queries: ["rust sqlite"], sources: [] },
      {
        status: "completed",
        sources: [{ url: "https://www.sqlite.org", title: "SQLite" }],
      },
    );
    expect(merged).toEqual({
      status: "completed",
      queries: ["rust sqlite"],
      sources: [{ url: "https://www.sqlite.org", title: "SQLite" }],
    });
  });
});

describe("false positives", () => {
  it("does not treat Playwright or MCP tools as hosted search", () => {
    expect(
      extractHostedSearchFromAssistantContent([
        {
          type: "toolCall",
          name: "mcp_playwright_browser_navigate",
          arguments: { url: "https://cn.bing.com/search?q=tibo" },
        },
      ]),
    ).toBeUndefined();
  });

  it("collapses streaming URL prefixes into one source", () => {
    const merged = mergeHostedSearch(
      { status: "searching", queries: [], sources: [{ url: "https://www.bing.com/search?q=t" }] },
      { status: "completed", sources: [{ url: "https://www.bing.com/search?q=tibo" }] },
    );
    expect(merged?.sources).toEqual([{ url: "https://www.bing.com/search?q=tibo" }]);
  });

  it("parses Grok/OpenAI web_search_call stream events", () => {
    const searching = parseHostedSearchStreamEvent({
      type: "response.output_item.added",
      item: { type: "web_search_call", action: { query: "tibo 重置哥" } },
    });
    expect(searching?.queries).toEqual(["tibo 重置哥"]);
    const cited = parseHostedSearchStreamEvent({
      type: "response.output_text.annotation.added",
      annotation: { type: "url_citation", url: "https://example.com/a", title: "A" },
    });
    expect(cited?.sources).toEqual([{ url: "https://example.com/a", title: "A" }]);
  });
});
describe("xAI Live Search", () => {
  it("supports the xAI vendor even on Chat Completions", () => {
    expect(
      supportsNativeWebSearch({
        api: "openai-completions",
        apiStyle: "chat_completions",
        vendorKey: "xai",
        baseUrl: "https://api.x.ai/v1",
      }),
    ).toBe(true);
  });

  it("drops Grok citation indexes that arrive as source titles", () => {
    const search = parseHostedSearchStreamEvent({
      citations: [{ url: "https://36kr.com/p/1", title: "5" }],
    });
    expect(search?.sources).toEqual([{ url: "https://36kr.com/p/1" }]);
  });



  it("attaches search_parameters on xAI Completions", () => {
    const next = attachNativeWebSearchToPayload(
      { model: "grok-4" },
      { api: "openai-completions", vendorKey: "xai", baseUrl: "https://api.x.ai/v1" },
    );
    expect(next).toEqual({
      model: "grok-4",
      search_parameters: { mode: "on", return_citations: true },
    });
  });

  it("reads Grok citation URLs from a completions chunk", () => {
    const search = parseHostedSearchStreamEvent({
      citations: ["https://example.com/a", "https://example.com/b"],
    });
    expect(search?.sources).toEqual([
      { url: "https://example.com/a" },
      { url: "https://example.com/b" },
    ]);
  });

  it("reads x_search_call sources like LiveAgent", () => {
    const search = parseHostedSearchStreamEvent({
      type: "response.output_item.done",
      item: {
        type: "x_search_call",
        action: {
          query: "tibo 重置哥",
          sources: [{ url: "https://example.com/tibo", title: "Tibo" }],
        },
      },
    });
    expect(search?.queries).toEqual(["tibo 重置哥"]);
    expect(search?.sources).toEqual([{ url: "https://example.com/tibo", title: "Tibo" }]);
  });
});

