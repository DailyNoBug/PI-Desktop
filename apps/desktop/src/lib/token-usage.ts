import type { TokenUsageHistoryResult } from "@pi-desktop/shared";

export const TOKEN_USAGE_WINDOW_DAYS = 14;

export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.max(0, Math.round(value)));
}

export function tokenUsageHistoryQuery(now = new Date()) {
  const start = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - (TOKEN_USAGE_WINDOW_DAYS - 1),
  );
  return {
    startDate: start.getTime(),
    endDate: now.getTime(),
    bucket: "day" as const,
  };
}

function localDateKey(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function todayTokenUsage(
  history: TokenUsageHistoryResult,
  now = new Date(),
) {
  return (
    history.items.find((item) => item.date === localDateKey(now)) ?? {
      date: localDateKey(now),
      timestamp: now.getTime(),
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      turnCount: 0,
    }
  );
}
