/**
 * Provider-native (hosted) web search: which wire APIs can carry a vendor
 * server tool, how to attach that tool, and how to recover queries/sources
 * from leaked client tool calls or stream events.
 *
 * Detection is the resolved wire API / apiStyle, never the vendor display
 * name or a model-id substring. Custom Chat Completions stay off unless the
 * target is xAI (`vendorKey` or api.x.ai).
 */



export type HostedSearchStatus = "searching" | "completed" | "failed";

export type HostedSearchSource = {
  url: string;
  title?: string;
  /** Vendor-supplied publisher/site name when present. Usually absent. */
  publisher?: string;
  /** Vendor-supplied publication date when present. Usually absent. */
  publishedAt?: string;
};

export type HostedSearch = {
  status: HostedSearchStatus;
  queries: string[];
  sources: HostedSearchSource[];
};

// Keep the Anthropic server tool on the stable GA contract. Newer dated
// versions are recognized if already present, but not sent: Claude relays
// reject unsupported tool types with 400 and expose no capability signal.
export const ANTHROPIC_WEB_SEARCH_TOOL_TYPE = "web_search_20250305" as const;


const NATIVE_WEB_SEARCH_WIRE_APIS = new Set([
  "anthropic-messages",
  "openai-responses",
]);

const NATIVE_WEB_SEARCH_API_STYLES = new Set([
  "anthropic_messages",
  "responses",
]);

const NATIVE_SEARCH_TOOL_NAMES = new Set([
  "websearch",
  "web_search",
  "builtin_web_search",
  "web_search_20250305",
  "web_search_20260209",
  "web_search_20260318",
  "web_search_preview",
  "web_search_call",
  "x_search",
  "x_keyword_search",
  "x_semantic_search",
]);

const NATIVE_FETCH_TOOL_NAMES = new Set([
  "webfetch",
  "web_fetch",
  "builtin_web_fetch",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeName(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

export function wireApiSupportsNativeWebSearch(api: string | undefined): boolean {
  return NATIVE_WEB_SEARCH_WIRE_APIS.has((api ?? "").trim().toLowerCase());
}

export function apiStyleSupportsNativeWebSearch(
  apiStyle: string | undefined,
): boolean {
  const style = (apiStyle ?? "").trim().toLowerCase();
  if (NATIVE_WEB_SEARCH_API_STYLES.has(style)) return true;
  return wireApiSupportsNativeWebSearch(style);
}
export type NativeWebSearchTarget = {
  api?: string;
  apiStyle?: string;
  vendorKey?: string;
  baseUrl?: string;
};

function hostnameOf(baseUrl: string | undefined): string {
  if (!baseUrl?.trim()) return "";
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isXaiNativeSearchTarget(target: NativeWebSearchTarget | undefined): boolean {
  const vendor = (target?.vendorKey ?? "").trim().toLowerCase();
  if (vendor === "xai" || vendor === "x-ai") return true;
  const host = hostnameOf(target?.baseUrl);
  return host === "api.x.ai" || host.endsWith(".x.ai");
}


export function supportsNativeWebSearch(target: NativeWebSearchTarget | undefined): boolean {
  if (!target) return false;
  if (wireApiSupportsNativeWebSearch(target.api)) return true;
  if (apiStyleSupportsNativeWebSearch(target.apiStyle)) return true;
  return isXaiNativeSearchTarget(target);
}

export function isNativeWebSearchToolName(toolName: string | undefined): boolean {
  const normalized = normalizeName(toolName);
  if (!normalized) return false;
  if (NATIVE_SEARCH_TOOL_NAMES.has(normalized)) return true;
  return (
    normalized.startsWith("web_search_call") ||
    normalized.startsWith("x_search_call")
  );
}

export function isNativeWebFetchToolName(toolName: string | undefined): boolean {
  const normalized = normalizeName(toolName);
  if (!normalized) return false;
  if (NATIVE_FETCH_TOOL_NAMES.has(normalized)) return true;
  return normalized.startsWith("web_fetch_2") || normalized.startsWith("web_fetch_call");
}

export function isHiddenNativeWebToolName(toolName: string | undefined): boolean {
  return isNativeWebSearchToolName(toolName) || isNativeWebFetchToolName(toolName);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return url.hostname.includes(".");
  } catch {
    return false;
  }
}
function sourceKey(source: HostedSearchSource): string {
  return source.url;
}

/** Drop citation indexes and raw URLs that Grok sometimes ships as `title`. */
function usableSourceTitle(value: string | undefined): string {
  const title = value?.trim() ?? "";
  if (!title || /^https?:\/\//i.test(title) || /^\d+$/.test(title)) return "";
  return title;
}

function collapsePrefixDuplicates(values: string[]): string[] {
  const unique = uniqueStrings(values);
  return unique.filter(
    (value) => !unique.some((other) => other.length > value.length && other.startsWith(value)),
  );
}


function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueStrings(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const text = value.trim();
    if (!text || out.includes(text)) continue;
    out.push(text);
  }
  return out;
}

export function hostedSearchHasContent(search: HostedSearch | undefined): boolean {
  if (!search) return false;
  return search.queries.length > 0 || search.sources.length > 0;
}

export function mergeHostedSearch(
  previous: HostedSearch | undefined,
  next: Partial<HostedSearch> | undefined,
): HostedSearch | undefined {
  if (!previous && !next) return undefined;
  const queries = collapsePrefixDuplicates([
    ...(previous?.queries ?? []),
    ...(next?.queries ?? []),
  ]);
  const sourcesByUrl = new Map<string, HostedSearchSource>();
  for (const source of [...(previous?.sources ?? []), ...(next?.sources ?? [])]) {
    if (!source.url || !isHttpUrl(source.url)) continue;
    const existing = sourcesByUrl.get(sourceKey(source));
    sourcesByUrl.set(sourceKey(source), {
      url: source.url,
      title: usableSourceTitle(source.title) || usableSourceTitle(existing?.title),

      publisher: source.publisher?.trim() || existing?.publisher,
      publishedAt: source.publishedAt?.trim() || existing?.publishedAt,
    });
  }
  const sources = collapsePrefixDuplicates([...sourcesByUrl.keys()]).map((url) => {
    const source = sourcesByUrl.get(url)!;
    return {
      url,
      ...(source.title ? { title: source.title } : {}),
      ...(source.publisher ? { publisher: source.publisher } : {}),
      ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}),
    };
  }).slice(0, 20);
  const status = next?.status ?? previous?.status ?? "searching";
  if (queries.length === 0 && sources.length === 0) {
    return status === "searching" ? { status, queries, sources } : undefined;
  }
  return { status, queries, sources };
}

function hasAnthropicWebSearchTool(tool: unknown): boolean {
  if (!isRecord(tool)) return false;
  return (
    tool.name === "web_search" ||
    tool.type === ANTHROPIC_WEB_SEARCH_TOOL_TYPE ||
    tool.type === "web_search_20260209" ||
    tool.type === "web_search_20260318"
  );
}

function hasOpenAIResponsesWebSearchTool(tool: unknown): boolean {
  if (!isRecord(tool)) return false;
  const type = tool.type;
  return (
    type === "web_search" ||
    type === "web_search_2025_08_26" ||
    type === "web_search_preview" ||
    type === "web_search_preview_2025_03_11"
  );
}

function appendUniqueTool(
  payload: Record<string, unknown>,
  tool: Record<string, unknown>,
  matches: (candidate: unknown) => boolean,
): Record<string, unknown> {
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  if (tools.some(matches)) return payload;
  return { ...payload, tools: [...tools, tool] };
}

function appendXaiLiveSearch(payload: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(payload.search_parameters)) return payload;
  return {
    ...payload,
    search_parameters: {
      mode: "on",
      return_citations: true,
    },
  };
}

/**
 * Attach the vendor hosted-search tool for the resolved wire API / xAI Live Search.
 * Unknown Chat Completions endpoints stay unchanged.
 */
export function attachNativeWebSearchToPayload(
  payload: unknown,
  apiOrTarget: string | NativeWebSearchTarget | undefined,
): unknown {
  const target: NativeWebSearchTarget =
    typeof apiOrTarget === "string" || apiOrTarget === undefined
      ? { api: apiOrTarget }
      : apiOrTarget;
  if (!isRecord(payload) || !supportsNativeWebSearch(target)) return payload;


  const wire = (target.api ?? "").trim().toLowerCase();
  if (wire === "anthropic-messages" || target.apiStyle === "anthropic_messages") {
    return appendUniqueTool(
      payload,
      { type: ANTHROPIC_WEB_SEARCH_TOOL_TYPE, name: "web_search" },
      hasAnthropicWebSearchTool,
    );
  }
  if (wire === "openai-responses" || target.apiStyle === "responses") {
    return appendUniqueTool(payload, { type: "web_search" }, hasOpenAIResponsesWebSearchTool);
  }
  if (isXaiNativeSearchTarget(target)) {
    if (wire === "openai-responses" || target.apiStyle === "responses") {
      return appendUniqueTool(payload, { type: "web_search" }, hasOpenAIResponsesWebSearchTool);
    }
    return appendXaiLiveSearch(payload);
  }
  return payload;
}

function readQuery(record: Record<string, unknown>): string {
  return (
    readString(record.query) ||
    readString(record.search_query) ||
    readString(record.additionalContext)
  );
}

function collectSources(value: unknown, into: HostedSearchSource[]): void {
  if (typeof value === "string") {
    const url = value.trim();
    if (url && isHttpUrl(url)) into.push({ url });
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectSources(entry, into);
    return;
  }
  if (!isRecord(value)) return;
  const url = readString(value.url ?? value.uri ?? value.link);
  if (url && isHttpUrl(url)) {
    const title = usableSourceTitle(readString(value.title ?? value.name));
    const publisher = readString(
      value.publisher ?? value.site_name ?? value.siteName,
    );
    const publishedAt = readString(
      value.publishedAt ?? value.published_date ?? value.published_at ?? value.date,
    );
    into.push({
      url,
      ...(title ? { title } : {}),
      ...(publisher ? { publisher } : {}),
      ...(publishedAt ? { publishedAt } : {}),
    });
  }

  for (const key of ["sources", "citations", "results", "output", "groundingChunks"] as const) {
    if (value[key] !== undefined) collectSources(value[key], into);
  }
  if (isRecord(value.web)) collectSources(value.web, into);
  if (isRecord(value.action)) collectSources(value.action, into);
  if (isRecord(value.annotation) && readString(value.annotation.type) === "url_citation") {
    collectSources(value.annotation, into);
  }
}

function collectNamedQueries(record: Record<string, unknown>, into: string[]): void {
  const query = readQuery(record);
  if (query) into.push(query);
  if (Array.isArray(record.queries)) {
    for (const entry of record.queries) {
      const text = readString(entry);
      if (text) into.push(text);
    }
  }
  if (Array.isArray(record.webSearchQueries)) {
    for (const entry of record.webSearchQueries) {
      const text = readString(entry);
      if (text) into.push(text);
    }
  }
  if (isRecord(record.action)) collectNamedQueries(record.action, into);
  else if (typeof record.action === "string") {
    try {
      const parsed = JSON.parse(record.action) as unknown;
      if (isRecord(parsed)) collectNamedQueries(parsed, into);
    } catch {
      /* ignore */
    }
  }
  if (isRecord(record.input)) collectNamedQueries(record.input, into);
  if (isRecord(record.arguments)) collectNamedQueries(record.arguments, into);
}

function extractCitationSearch(raw: Record<string, unknown>): HostedSearch | undefined {
  const sources: HostedSearchSource[] = [];
  collectSources(raw.citations, sources);
  const choices = Array.isArray(raw.choices) ? raw.choices : [];
  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    collectSources(choice.citations, sources);
    if (isRecord(choice.delta)) collectSources(choice.delta.citations, sources);
    if (isRecord(choice.message)) collectSources(choice.message.citations, sources);
  }
  return packSearch([], sources, "completed");
}

function packSearch(
  queries: string[],
  sources: HostedSearchSource[],
  status?: HostedSearchStatus,
): HostedSearch | undefined {
  const uniqueQueries = uniqueStrings(queries);
  const merged = mergeHostedSearch(undefined, {
    status: status ?? (sources.length > 0 ? "completed" : uniqueQueries.length > 0 ? "searching" : undefined),
    queries: uniqueQueries,
    sources,
  });
  if (!merged) return undefined;
  if (!hostedSearchHasContent(merged) && merged.status !== "searching") return undefined;
  return merged;
}

function toolCallName(part: Record<string, unknown>): string {
  return readString(part.name ?? part.toolName);
}

function isSearchContentPart(part: Record<string, unknown>): boolean {
  const type = readString(part.type);
  const name = toolCallName(part);
  if (isHiddenNativeWebToolName(name)) return true;
  if (type === "web_search_call" || type === "x_search_call" || type === "web_search_tool_result") {
    return true;
  }
  if (type === "server_tool_use") return isHiddenNativeWebToolName(name);
  if (type === "url_citation") return true;
  return false;
}

/**
 * Recover hosted-search metadata from a pi-ai assistant `content` array or a
 * leaked client tool-call payload. Only native search/fetch blocks count —
 * MCP, Playwright, and other local tools must not become search queries.
 */
export function extractHostedSearchFromAssistantContent(
  content: unknown,
): HostedSearch | undefined {
  if (isRecord(content) && isSearchContentPart(content)) {
    const queries: string[] = [];
    const sources: HostedSearchSource[] = [];
    collectNamedQueries(content, queries);
    collectSources(content.arguments ?? content.input ?? content.content ?? content, sources);
    return packSearch(queries, sources);
  }
  if (!Array.isArray(content)) return undefined;
  let found: HostedSearch | undefined;
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (Array.isArray(part.citations)) {
      const sources: HostedSearchSource[] = [];
      collectSources(part.citations, sources);
      found = mergeHostedSearch(found, packSearch([], sources, "completed"));
    }
    if (!isSearchContentPart(part)) continue;
    const queries: string[] = [];
    const sources: HostedSearchSource[] = [];
    collectNamedQueries(part, queries);
    collectSources(part.arguments ?? part.input ?? part.content ?? part, sources);
    found = mergeHostedSearch(found, packSearch(queries, sources));
  }
  return found;
}

function isXaiSearchItemType(itemType: string): boolean {
  return (
    itemType === "web_search_call" ||
    itemType === "x_search_call" ||
    itemType === "x_search_call_output"
  );
}

/**
 * Parse one SSE/JSON stream event from OpenAI Responses, xAI, or Anthropic.
 * Unrelated tool traffic returns undefined.
 */
export function parseHostedSearchStreamEvent(raw: unknown): HostedSearch | undefined {
  if (!isRecord(raw)) return undefined;
  const citations = extractCitationSearch(raw);
  const type = readString(raw.type);

  if (type === "response.output_item.added" || type === "response.output_item.done") {
    const item = isRecord(raw.item) ? raw.item : {};
    const itemType = readString(item.type);
    const name = readString(item.name);
    const customSearch =
      itemType === "custom_tool_call" &&
      (name === "x_keyword_search" || name === "x_semantic_search");
    if (isXaiSearchItemType(itemType) || isHiddenNativeWebToolName(name) || customSearch) {
      const queries: string[] = [];
      const sources: HostedSearchSource[] = [];
      collectNamedQueries(item, queries);
      collectSources(item, sources);
      const done = type.endsWith(".done") || itemType.endsWith("_output");
      return mergeHostedSearch(
        citations,
        packSearch(queries, sources, done || sources.length > 0 ? "completed" : "searching"),
      ) ?? citations;
    }
    return citations;
  }

  if (type.startsWith("response.web_search_call.") || type.startsWith("response.x_search_call.")) {
    const suffix = type.split(".").pop() ?? "";
    const failed = /fail|error|cancel/.test(suffix);
    const done = /complete|completed|done/.test(suffix);
    const item = isRecord(raw.item) ? raw.item : raw;
    const queries: string[] = [];
    const sources: HostedSearchSource[] = [];
    if (isRecord(item)) {
      collectNamedQueries(item, queries);
      collectSources(item, sources);
    }
    return mergeHostedSearch(
      citations,
      packSearch(
        queries,
        sources,
        failed ? "failed" : done || sources.length > 0 ? "completed" : "searching",
      ),
    ) ?? citations;
  }

  if (type === "response.output_text.annotation.added") {
    const sources: HostedSearchSource[] = [];
    collectSources(raw, sources);
    return packSearch([], sources, "completed");
  }

  if (type === "content_block_start") {
    const block = isRecord(raw.content_block) ? raw.content_block : {};
    const blockType = readString(block.type);
    const name = readString(block.name);
    if (blockType === "server_tool_use" && isHiddenNativeWebToolName(name)) {
      const queries: string[] = [];
      collectNamedQueries(block, queries);
      return packSearch(queries, [], "searching");
    }
    if (blockType === "web_search_tool_result" || blockType === "web_search_tool_result_error") {
      const sources: HostedSearchSource[] = [];
      collectSources(block.content, sources);
      return packSearch(
        [],
        sources,
        blockType.endsWith("_error") ? "failed" : "completed",
      );
    }
    return undefined;
  }

  if (type === "content_block_delta") {
    const delta = isRecord(raw.delta) ? raw.delta : {};
    if (readString(delta.type) === "citations_delta") {
      const sources: HostedSearchSource[] = [];
      collectSources(delta, sources);
      return packSearch([], sources, "completed") ?? citations;
    }
  }

  return citations;
}

export function normalizeHostedSearchStatus(
  value: string | undefined,
): HostedSearchStatus {
  const normalized = (value ?? "").trim().toLowerCase();
  if (/fail|error|cancel/.test(normalized)) return "failed";
  if (/complete|completed|done|succeeded|finished/.test(normalized)) return "completed";
  return "searching";
}
