import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import {
  TOKEN_USAGE_WINDOW_DAYS,
  formatTokenCount,
  todayTokenUsage,
  tokenUsageHistoryQuery,
} from "../lib/token-usage";
import { IconActivity, IconRefresh } from "./icons";
import { TooltipButton } from "./ui";
import type { TokenUsageHistoryResult } from "@pi-desktop/shared";

type TokenUsageLoadState = "loading" | "ready" | "error";
type TokenUsagePopoverPosition = { bottom: number; left: number };

export function TokenUsageSummary({
  onBeforeOpen,
}: {
  onBeforeOpen?: () => void;
}) {
  const { t } = useTranslation();
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const loadRequestId = useRef(0);
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<TokenUsageHistoryResult | null>(null);
  const [loadState, setLoadState] =
    useState<TokenUsageLoadState | null>(null);
  const [popoverPosition, setPopoverPosition] =
    useState<TokenUsagePopoverPosition | null>(null);

  const closeSummary = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) {
      requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  const loadHistory = useCallback(async () => {
    const requestId = loadRequestId.current + 1;
    loadRequestId.current = requestId;
    setLoadState("loading");
    try {
      const result = await api.getTokenUsageHistory(
        tokenUsageHistoryQuery(),
      );
      if (loadRequestId.current !== requestId) return;
      setHistory(result);
      setLoadState("ready");
    } catch {
      if (loadRequestId.current !== requestId) return;
      setLoadState("error");
    }
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPopoverPosition(null);
      return;
    }
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(340, window.innerWidth - 24);
      const left = Math.max(
        12,
        Math.min(rect.left, window.innerWidth - width - 12),
      );
      const bottom = Math.max(12, window.innerHeight - rect.top + 8);
      setPopoverPosition((previous) =>
        previous?.bottom === bottom && previous.left === left
          ? previous
          : { bottom, left },
      );
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  useEffect(() => {
    if (open) void loadHistory();
  }, [loadHistory, open]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      closeSummary(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeSummary();
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [closeSummary, open]);

  const today = history ? todayTokenUsage(history) : undefined;
  const maxDayTotal = history
    ? Math.max(...history.items.map((item) => item.totalTokens), 1)
    : 1;
  const loading = loadState === "loading";

  const onTriggerClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (open) closeSummary();
    else {
      onBeforeOpen?.();
      setOpen(true);
    }
  };

  return (
    <div className="token-usage-summary" ref={rootRef}>
      <TooltipButton
        ref={triggerRef}
        type="button"
        className={`footer-action ${open ? "active" : ""}`}
        data-nav="token-usage"
        tooltip={t("tokenUsage.title")}
        ariaLabel={t("tokenUsage.title")}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        onClick={onTriggerClick}
      >
        <IconActivity size={14} aria-hidden />
      </TooltipButton>

      {open && popoverPosition && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={popoverRef}
              id={panelId}
              className="token-usage-popover"
              role="dialog"
              aria-modal={false}
              aria-labelledby="token-usage-title"
              style={popoverPosition}
            >
              <header className="token-usage-header">
                <h2 id="token-usage-title">{t("tokenUsage.title")}</h2>
                <TooltipButton
                  type="button"
                  className="notification-action token-usage-refresh"
                  tooltip={t("tokenUsage.retry")}
                  ariaLabel={t("tokenUsage.retry")}
                  disabled={loading}
                  onClick={() => void loadHistory()}
                >
                  <IconRefresh size={15} aria-hidden />
                </TooltipButton>
              </header>

              {loadState === "error" ? (
                <div className="token-usage-error" role="status">
                  <span>{t("tokenUsage.loadFailed")}</span>
                  <button type="button" onClick={() => void loadHistory()}>
                    {t("tokenUsage.retry")}
                  </button>
                </div>
              ) : history ? (
                <div
                  className="token-usage-body"
                  aria-busy={loading || undefined}
                >
                  <div className="token-usage-total">
                    <div>
                      <span>{t("tokenUsage.range")}</span>
                      <strong>
                        {formatTokenCount(history.totals.totalTokens)}
                      </strong>
                    </div>
                    <div>
                      <span>{t("tokenUsage.turns")}</span>
                      <strong>
                        {history.totals.turnCount.toLocaleString()}
                      </strong>
                    </div>
                  </div>

                  <div
                    className="token-usage-chart"
                    role="img"
                    aria-label={t("tokenUsage.chartSummary", {
                      days: TOKEN_USAGE_WINDOW_DAYS,
                      tokens: formatTokenCount(history.totals.totalTokens),
                    })}
                  >
                    {history.items.map((item, index) => {
                      const active =
                        index === history.items.length - 1 ||
                        item.date === today?.date;
                      return (
                        <span
                          key={item.date}
                          className={active ? "active" : ""}
                          data-empty={item.totalTokens === 0 ? "true" : "false"}
                          style={{
                            height: `${Math.max(
                              2,
                              Math.round(
                                (item.totalTokens / maxDayTotal) * 48,
                              ),
                            )}px`,
                          }}
                          title={`${item.date} · ${formatTokenCount(item.totalTokens)}`}
                        />
                      );
                    })}
                  </div>

                  <dl className="token-usage-breakdown">
                    <div>
                      <dt>{t("tokenUsage.today")}</dt>
                      <dd>{formatTokenCount(today?.totalTokens ?? 0)}</dd>
                    </div>
                    <div>
                      <dt>{t("tokenUsage.input")}</dt>
                      <dd>{formatTokenCount(today?.inputTokens ?? 0)}</dd>
                    </div>
                    <div>
                      <dt>{t("tokenUsage.output")}</dt>
                      <dd>{formatTokenCount(today?.outputTokens ?? 0)}</dd>
                    </div>
                    <div>
                      <dt>{t("tokenUsage.cacheRead")}</dt>
                      <dd>{formatTokenCount(today?.cacheReadTokens ?? 0)}</dd>
                    </div>
                    <div>
                      <dt>{t("tokenUsage.cacheWrite")}</dt>
                      <dd>{formatTokenCount(today?.cacheWriteTokens ?? 0)}</dd>
                    </div>
                    <div>
                      <dt>{t("tokenUsage.reasoning")}</dt>
                      <dd>{formatTokenCount(today?.reasoningTokens ?? 0)}</dd>
                    </div>
                  </dl>
                </div>
              ) : (
                <div className="token-usage-loading" role="status">
                  {t("tokenUsage.range")}
                </div>
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
