import type { HostedSearchSource } from "@pi-desktop/shared";
import { api } from "./api";
import { useAppStore } from "../stores/app-store";

export const HOSTED_SEARCH_PREVIEW_COUNT = 5;

export function hostedSearchHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function hostedSearchFaviconCandidates(url: string): string[] {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return [];
    return [`${parsed.origin}/favicon.ico`];
  } catch {
    return [];
  }
}

export function hostedSearchLabel(source: HostedSearchSource): string {
  return source.publisher?.trim() || hostedSearchHost(source.url);
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/** Visible title for a source. Never falls back to the raw URL or a citation index. */
export function hostedSearchTitle(source: HostedSearchSource): string {
  const title = source.title?.trim() ?? "";
  if (title && !looksLikeUrl(title) && !/^\d+$/.test(title)) return title;
  return hostedSearchHost(source.url);
}


const INLINE_CITATION_TOKEN =
  /\{\s*render_inline_citation(?:\s*\([^}]*\)|\s+[^}]+)\s*\}|\brender_inline_citation\s*\([^)]*\)/gi;

/** Turn Grok `{render_inline_citation(citation_id=N)}` / `{render_inline_citation citation_id="N"}` into cite links. */
export function rewriteInlineCitationMarkup(
  text: string,
  sources: readonly HostedSearchSource[],
): string {
  if (!text.includes("render_inline_citation")) return text;
  return text.replace(new RegExp(`(?:${INLINE_CITATION_TOKEN.source})+`, "gi"), (run) => {
    const ids = [...run.matchAll(/citation_id\s*=\s*["']?(\d+)["']?/gi)].map((match) =>
      Number(match[1]),
    );
    const valid = ids.filter((id) => sources[id - 1] || sources[id]);
    if (valid.length === 0) return "";
    return `[ ](#cite=${valid.join(",")})`;
  });
}

export function urlsReferToSameSource(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return (
      a.hostname.replace(/^www\./, "") === b.hostname.replace(/^www\./, "") &&
      a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "")
    );
  } catch {
    return left === right;
  }
}

export function sourcesForHref(
  href: string | undefined,
  sources: readonly HostedSearchSource[],
): HostedSearchSource[] {
  if (!href) return [];
  const hashIndex = href.indexOf("#cite=");
  const citeRef = hashIndex >= 0 ? href.slice(hashIndex) : href;
  const citeIds = citeRef.match(/^#cite=([\d,]+)$/);
  if (citeIds) {
    const matched: HostedSearchSource[] = [];
    for (const raw of citeIds[1].split(",")) {
      const id = Number(raw);
      const source = sources[id - 1] ?? sources[id];
      if (source) matched.push(source);
    }
    return matched;
  }
  return sources.filter((source) => urlsReferToSameSource(source.url, href));
}

export function openChatHttpUrl(url: string): void {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return;
  const target = useAppStore.getState().settings?.linkOpenTarget ?? "workpanel";
  if (target === "external") {
    void api.browserOpenExternal(trimmed);
    return;
  }
  useAppStore.getState().openUrlInWorkPanel(trimmed);
}
