import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { HostedSearchSource } from "@pi-desktop/shared";
import { HostedSearchFavicon } from "./HostedSearchFavicon";
import { IconChevronLeft, IconChevronRight } from "./icons";
import {
  hostedSearchLabel,
  hostedSearchTitle,
  openChatHttpUrl,
  sourcesForHref,
} from "../lib/hosted-search-ui";

const HostedSearchCitationsContext = createContext<readonly HostedSearchSource[]>([]);

export function HostedSearchCitationsProvider({
  sources,
  children,
}: {
  sources: readonly HostedSearchSource[];
  children: ReactNode;
}) {
  return (
    <HostedSearchCitationsContext.Provider value={sources}>
      {children}
    </HostedSearchCitationsContext.Provider>
  );
}

export function useHostedSearchCitationSources(
  href: string | undefined,
): HostedSearchSource[] {
  const sources = useContext(HostedSearchCitationsContext);
  return sourcesForHref(href, sources);
}

function formatPublishedAt(value: string | undefined): string {
  if (!value?.trim()) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.trim();
  return date.toLocaleDateString();
}

export function CitationBadge({ sources }: { sources: HostedSearchSource[] }) {
  const { t } = useTranslation();
  const cardId = useId();
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const hideTimer = useRef<number | null>(null);
  const current = sources[Math.min(index, sources.length - 1)];

  const cancelHide = () => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };
  const show = () => {
    cancelHide();
    setOpen(true);
  };
  const hide = () => {
    cancelHide();
    hideTimer.current = window.setTimeout(() => setOpen(false), 120);
  };

  useEffect(() => () => cancelHide(), []);

  const openSource = useCallback(
    (source: HostedSearchSource | undefined) => {
      if (!source) return;
      openChatHttpUrl(source.url);
    },
    [],
  );

  if (!current) return null;
  const extra = sources.length - 1;
  const label = hostedSearchLabel(current);
  const title = hostedSearchTitle(current);
  const published = formatPublishedAt(current.publishedAt);
  const rect = rootRef.current?.getBoundingClientRect();

  return (
    <span
      ref={rootRef}
      className="citation-badge-wrap"
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      <button
        type="button"
        className="citation-badge"
        aria-describedby={open ? cardId : undefined}
        onClick={() => openSource(current)}
      >
        <HostedSearchFavicon url={current.url} size={12} />
        <span className="citation-badge-label">{label}</span>
        {extra > 0 ? <span className="citation-badge-extra">+{extra}</span> : null}
      </button>
      {open && rect
        ? createPortal(
            <div
              ref={cardRef}
              id={cardId}
              role="tooltip"
              className="citation-card"
              style={{
                top: rect.bottom + 8,
                left: Math.min(rect.left, window.innerWidth - 320),
              }}
              onMouseEnter={show}
              onMouseLeave={hide}
            >
              {sources.length > 1 ? (
                <div className="citation-card-nav">
                  <button
                    type="button"
                    className="citation-card-nav-btn"
                    aria-label={t("chat.webSearchCitationPrev")}
                    onClick={() =>
                      setIndex((value) => (value - 1 + sources.length) % sources.length)
                    }
                  >
                    <IconChevronLeft size={14} />
                  </button>
                  <span>
                    {index + 1}/{sources.length}
                  </span>
                  <button
                    type="button"
                    className="citation-card-nav-btn"
                    aria-label={t("chat.webSearchCitationNext")}
                    onClick={() => setIndex((value) => (value + 1) % sources.length)}
                  >
                    <IconChevronRight size={14} />
                  </button>
                </div>
              ) : null}
              <button
                type="button"
                className="citation-card-body"
                onClick={() => openSource(current)}
              >
                <HostedSearchFavicon url={current.url} size={28} />
                <span className="citation-card-copy">
                  <span className="citation-card-publisher">{label}</span>
                  <span className="citation-card-title">{title}</span>
                  {published ? (
                    <span className="citation-card-date">{published}</span>
                  ) : null}
                </span>
              </button>
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
