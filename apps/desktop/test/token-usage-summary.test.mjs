import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";
import {
  TOKEN_USAGE_WINDOW_DAYS,
  formatTokenCount,
  todayTokenUsage,
  tokenUsageHistoryQuery,
} from "../src/lib/token-usage.ts";

const componentSource = await readFile(
  new URL("../src/components/TokenUsageSummary.tsx", import.meta.url),
  "utf8",
);
const sidebarSource = await readFile(
  new URL("../src/components/Sidebar.tsx", import.meta.url),
  "utf8",
);
const styles = await loadStyles();

test("token counts use compact bounded formatting", () => {
  assert.equal(formatTokenCount(0), "0");
  assert.equal(formatTokenCount(999), "999");
  assert.equal(formatTokenCount(1_500), "1.5k");
  assert.equal(formatTokenCount(25_000), "25k");
  assert.equal(formatTokenCount(1_400_000), "1.4M");
  assert.equal(formatTokenCount(24_000_000), "24M");
});

test("the summary requests fourteen local-calendar day buckets", () => {
  const now = new Date(2026, 8, 11, 15, 4, 5, 600);
  const query = tokenUsageHistoryQuery(now);
  assert.equal(query.bucket, "day");
  assert.equal(query.endDate, now.getTime());
  assert.equal(
    query.startDate,
    new Date(2026, 7, 29, 0, 0, 0, 0).getTime(),
  );
});

test("today's rollup falls back to zero without dropping the date", () => {
  const now = new Date(2026, 8, 11, 16);
  const history = {
    bucket: "day",
    rangeStart: 0,
    rangeEnd: now.getTime(),
    items: [],
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      turnCount: 0,
    },
  };
  assert.deepEqual(todayTokenUsage(history, now), {
    date: "2026-09-11",
    timestamp: now.getTime(),
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    turnCount: 0,
  });
});

test("the sidebar exposes a read-only host history summary", () => {
  assert.equal(TOKEN_USAGE_WINDOW_DAYS, 14);
  assert.match(sidebarSource, /<TokenUsageSummary onBeforeOpen=/);
  assert.match(componentSource, /api\.getTokenUsageHistory\(/);
  assert.match(componentSource, /tokenUsageHistoryQuery\(\)/);
  assert.match(componentSource, /role="dialog"/);
  assert.match(componentSource, /aria-expanded=\{open\}/);
  assert.match(componentSource, /<IconActivity size=\{14\} aria-hidden \/>/);
  assert.match(componentSource, /tokenUsage\.cacheRead/);
  assert.match(componentSource, /tokenUsage\.reasoning/);
  assert.match(
    styles,
    /\.token-usage-popover\s*\{[^}]*width:\s*min\(340px,\s*calc\(100vw - 24px\)\)/s,
  );
});

test("every shipped locale defines token summary copy", async () => {
  const localeDir = new URL(
    "../../../packages/i18n/src/locales/",
    import.meta.url,
  );
  const locales = (await readdir(localeDir)).filter((name) => !name.endsWith(".ts"));
  const requiredKeys = [
    "title",
    "range",
    "turns",
    "today",
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "reasoning",
    "loadFailed",
    "retry",
    "chartSummary",
  ];
  for (const locale of locales) {
    const source = await readFile(new URL(`${locale}/index.ts`, localeDir), "utf8");
    const block = source.match(/\n\s*(?:tokenUsage:|"tokenUsage":)\s*\{[\s\S]*?\n\s*\}/)?.[0] ?? "";
    assert.ok(block, `${locale} must define tokenUsage`);
    for (const key of requiredKeys) {
      assert.match(
        block,
        new RegExp(`(?:"${key}"|${key})\\s*:`),
        `${locale} missing ${key}`,
      );
    }
  }
});
