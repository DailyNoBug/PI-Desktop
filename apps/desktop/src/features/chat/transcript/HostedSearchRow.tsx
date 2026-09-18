import { memo, useCallback, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { hostedSearchHasContent, type UiMessage } from "@pi-desktop/shared";
import { HostedSearchFavicon } from "../../../components/HostedSearchFavicon";
import { IconChevronRight, IconGlobe, IconSearch } from "../../../components/icons";
import {
  HOSTED_SEARCH_PREVIEW_COUNT,
  hostedSearchHost,
  hostedSearchTitle,
  openChatHttpUrl,
} from "../../../lib/hosted-search-ui";
import { useAutomaticDisclosure } from "./shared";

export const HostedSearchRow = memo(function HostedSearchRow({
  message,
  streaming,
  autoOpen = false,
  onUserInteraction,
}: {
  message: UiMessage;
  streaming: boolean;
  autoOpen?: boolean;
  onUserInteraction?: () => void;
}) {
  const { t } = useTranslation();
  const detailsId = useId();
  const search = message.hostedSearch;
  const disclosure = useAutomaticDisclosure(
    autoOpen && search?.status === "completed",
  );
  const { open, toggle: toggleDisclosure } = disclosure;
  const [showAll, setShowAll] = useState(false);
  const toggleRow = useCallback(() => {
    onUserInteraction?.();
    toggleDisclosure();
  }, [onUserInteraction, toggleDisclosure]);

  const queries = useMemo(
    () => (search?.queries ?? []).map((item) => item.trim()).filter(Boolean),
    [search?.queries],
  );
  const sources = search?.sources ?? [];
  const visibleSources = showAll
    ? sources
    : sources.slice(0, HOSTED_SEARCH_PREVIEW_COUNT);
  const hiddenCount = Math.max(0, sources.length - visibleSources.length);
  const running = Boolean(streaming && search?.status === "searching");

  if (!search || (!hostedSearchHasContent(search) && !running)) return null;

  const title = running
    ? t("chat.webSearchRunning")
    : t("chat.webSearchSummary", {
        searchCount: Math.max(queries.length, 1),
        sourceCount: sources.length,
      });

  return (
    <section className={`hosted-search-row${open ? " open" : ""}${running ? " running" : ""}`}>
      <button
        type="button"
        ref={disclosure.titleRef}
        className="tool-activity-header"
        aria-expanded={open}
        aria-controls={detailsId}
        aria-label={t(open ? "chat.webSearchHide" : "chat.webSearchShow")}
        onClick={toggleRow}
      >
        <span className="tool-activity-icon" aria-hidden>
          {running ? <span className="tool-spinner" /> : <IconGlobe size={14} />}
        </span>
        <span className={`tool-activity-label${running ? " running" : ""}`}>{title}</span>
        <span className="tool-activity-caret" aria-hidden>
          <IconChevronRight size={12} />
        </span>
      </button>
      <div id={detailsId} className="hosted-search-body" hidden={!open}>
        {queries.length > 0 ? (
          <ul className="hosted-search-queries">
            {queries.map((query) => (
              <li key={query} className="hosted-search-query">
                <IconSearch size={12} aria-hidden />
                <span>{query}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {sources.length > 0 ? (
          <ul className="hosted-search-sources">
            {visibleSources.map((source) => {
              const host = hostedSearchHost(source.url);
              const label = hostedSearchTitle(source);
              return (
                <li key={source.url}>
                  <button
                    type="button"
                    className="hosted-search-source"
                    title={`${label} ${host}`}
                    onClick={() => openChatHttpUrl(source.url)}
                  >
                    <HostedSearchFavicon url={source.url} />
                    <span className="hosted-search-source-main">
                      <span className="hosted-search-source-title">{label}</span>
                      <span className="hosted-search-source-host">{host}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="hosted-search-empty">{t("chat.webSearchEmpty")}</p>
        )}
        {hiddenCount > 0 ? (
          <button
            type="button"
            className="hosted-search-more"
            onClick={() => setShowAll(true)}
          >
            {t("chat.webSearchMore", { count: hiddenCount })}
          </button>
        ) : null}
      </div>
    </section>
  );
});
