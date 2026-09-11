import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { PluginViewMeta } from "@pi-desktop/shared";
import {
  isKnownWorkPanelTab,
  parsePluginViewRef,
  pluginWorkPanelTab,
  toolWorkPanelTab,
} from "../../lib/work-panel-tabs";
import { pluginViewIcon, pluginViewInitial } from "../../lib/plugin-view-icons";
import { useAppStore } from "../../stores/app-store";
import type { WorkPanelTab } from "../../stores/app-store";
import { cx } from "../ui";
import { TooltipButton } from "../ui";
import type { IconProps } from "../icons";
import {
  IconBot,
  IconChevronLeft,
  IconClose,
  IconDiff,
  IconFileText,
  IconPlug,
  IconPlus,
} from "../icons";
import { ReviewTab } from "./ReviewTab";
import { FilesTab } from "./FilesTab";
import { PluginViewTab } from "./PluginViewTab";
import { SubagentPanel } from "./SubagentPanel";
import type { SubagentPanelSelection } from "../../lib/subagent-panel";
import {
  WORK_PANEL_MAX_WIDTH,
  WORK_PANEL_MIN_WIDTH,
  clampWorkPanelWidth,
} from "../../lib/work-panel-resize";
import { placeWorkPanelMenu } from "../../lib/work-panel-menu-position";

const TAB_ICONS = {
  review: IconDiff,
  file: IconFileText,
  plugin: IconPlug,
} as const;

type WorkPanelResizeState = {
  pointerId: number;
  startClientX: number;
  startWidth: number;
  currentWidth: number;
  frame: number;
};

type WorkPanelTool = {
  id: string;
  tab: WorkPanelTab;
  label: string;
  icon: ComponentType<IconProps> | null;
  initial?: string;
  description?: string;
  shortcut?: string;
};

function tabLabel(
  tab: WorkPanelTab,
  t: (key: string) => string,
  pluginViews: PluginViewMeta[],
) {
  if (tab.kind === "plugin") {
    const view = pluginViews.find((candidate) => candidate.ref === tab.resource);
    // A view whose plugin was disabled mid-session no longer resolves; fall
    // back to its id rather than leaving the tab blank until it closes.
    return view?.title ?? tab.resource ?? t("panel.tabs.plugin");
  }
  if (tab.kind !== "file") return t(`panel.tabs.${tab.kind}`);
  const path = tab.resource ?? "";
  return path.split("/").filter(Boolean).pop() || t("panel.tabs.file");
}

function workPanelTools(
  t: (key: string) => string,
  pluginViews: PluginViewMeta[],
): WorkPanelTool[] {
  // Review is the only host-owned launcher. Files, Browser, and every future
  // tool are plugin-contributed views, so their list stays data-driven.
  return [
    {
      id: "review",
      tab: toolWorkPanelTab("review"),
      label: t("panel.tabs.review"),
      icon: IconDiff,
    },
    ...pluginViews.map((view) => {
      const Icon = pluginViewIcon(view.icon);
      return {
        id: view.ref,
        tab: pluginWorkPanelTab(view.pluginId, view.viewId),
        label: view.title,
        icon: Icon,
        ...(Icon ? {} : { initial: pluginViewInitial(view.title) }),
        description: view.pluginName,
      };
    }),
  ];
}

function ToolIcon({ item, size = 15 }: { item: WorkPanelTool; size?: number }) {
  if (item.icon) return <item.icon size={size} />;
  return (
    <span className="work-panel-view-initial" aria-hidden>
      {item.initial}
    </span>
  );
}

export function WorkPanel({
  panelBlocked = false,
  exiting = false,
  onExitAnimationEnd,
  subagentPanel = null,
  onCloseSubagentPanel,
}: {
  /**
   * Hides every native surface in the panel. Both the preview browser and a
   * plugin view are `WebContentsView`s composited above renderer content, so a
   * blocking overlay must suppress them alike.
   */
  panelBlocked?: boolean;
  /** Plays work-panel-out; parent unmounts after animationend. */
  exiting?: boolean;
  onExitAnimationEnd?: () => void;
  /** Temporarily replaces the resource body with the selected subagent detail. */
  subagentPanel?: SubagentPanelSelection | null;
  onCloseSubagentPanel?: () => void;
}) {
  const { t } = useTranslation();
  const rawTabs = useAppStore((s) => s.workPanelTabs);
  const tabs = rawTabs.filter(isKnownWorkPanelTab);
  const activeTabId = useAppStore((s) => s.activeWorkPanelTabId);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const pluginViews = useAppStore((s) => s.pluginViews);
  const width = useAppStore((s) => s.workPanelWidth);
  const activateTab = useAppStore((s) => s.activateWorkPanelTab);
  const closeTab = useAppStore((s) => s.closeWorkPanelTab);
  const openWorkPanelTab = useAppStore((s) => s.openWorkPanelTab);
  const setWidth = useAppStore((s) => s.setWorkPanelWidth);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const tools = workPanelTools(t, pluginViews);

  const [panelDragWidth, setPanelDragWidth] = useState<number | null>(null);
  const panelResizeState = useRef<WorkPanelResizeState | null>(null);
  const tabButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const newTabButtonRef = useRef<HTMLButtonElement | null>(null);
  const newTabMenuRef = useRef<HTMLDivElement | null>(null);
  const menuOpenFocus = useRef<"active" | "last">("active");
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const [nativeSurfaceReadyForExit, setNativeSurfaceReadyForExit] =
    useState(false);

  const renderPanelWidth = clampWorkPanelWidth(panelDragWidth ?? width);
  const isResizing = panelDragWidth !== null;

  useEffect(() => {
    if (isResizing) {
      document.documentElement.setAttribute("data-work-panel-resizing", "true");
    } else {
      document.documentElement.removeAttribute("data-work-panel-resizing");
    }
    return () => {
      document.documentElement.removeAttribute("data-work-panel-resizing");
    };
  }, [isResizing]);

  const menuItems = useCallback(
    () =>
      Array.from(
        newTabMenuRef.current?.querySelectorAll<HTMLButtonElement>(
          "[data-work-panel-menu-item]",
        ) ?? [],
      ),
    [],
  );

  const closeMenu = useCallback((restoreFocus = false) => {
    setMenuOpen(false);
    setMenuPosition(null);
    if (restoreFocus) requestAnimationFrame(() => newTabButtonRef.current?.focus());
  }, []);

  const updateMenuPosition = useCallback(() => {
    const trigger = newTabButtonRef.current;
    const menu = newTabMenuRef.current;
    if (!trigger || !menu) return;

    const triggerRect = trigger.getBoundingClientRect();
    if (triggerRect.bottom <= 0 || triggerRect.top >= window.innerHeight) {
      closeMenu();
      return;
    }

    const menuRect = menu.getBoundingClientRect();
    const panelRect = trigger.closest(".work-panel")?.getBoundingClientRect();
    const placement = placeWorkPanelMenu({
      trigger: {
        left: triggerRect.left,
        top: triggerRect.top,
        bottom: triggerRect.bottom,
      },
      menu: { width: menuRect.width, height: menuRect.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      boundary: panelRect
        ? { left: panelRect.left, right: panelRect.right }
        : undefined,
    });
    setMenuPosition((previous) =>
      previous?.top === placement.top && previous.left === placement.left
        ? previous
        : placement,
    );
  }, [closeMenu]);

  useEffect(() => {
    if (!exiting) {
      setNativeSurfaceReadyForExit(false);
      return;
    }
    // Plugin views (and the host guest clamped to them) hide via `blocked`
    // before the dock CSS animation starts.
    setNativeSurfaceReadyForExit(true);
  }, [exiting]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        newTabButtonRef.current?.contains(target) ||
        newTabMenuRef.current?.contains(target)
      ) {
        return;
      }
      closeMenu();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu(true);
    };
    const onViewportChange = () => updateMenuPosition();
    const onRendererBlur = () => closeMenu();
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("blur", onRendererBlur);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
      window.removeEventListener("blur", onRendererBlur);
    };
  }, [closeMenu, menuOpen, updateMenuPosition]);

  useEffect(() => {
    if (!menuOpen) setMenuPosition(null);
  }, [menuOpen]);

  useLayoutEffect(() => {
    if (!menuOpen) return;
    const frame = window.requestAnimationFrame(updateMenuPosition);
    return () => window.cancelAnimationFrame(frame);
  }, [menuOpen, tabs.length, tools.length, updateMenuPosition]);

  useEffect(() => {
    if (!menuOpen) return;
    const menu = newTabMenuRef.current;
    const trigger = newTabButtonRef.current;
    if (!menu || !trigger || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateMenuPosition);
    observer.observe(menu);
    observer.observe(trigger);
    return () => observer.disconnect();
  }, [menuOpen, updateMenuPosition]);

  useEffect(() => {
    if (!menuOpen || !menuPosition) return;
    const target = menuOpenFocus.current;
    menuOpenFocus.current = "active";
    requestAnimationFrame(() => {
      const items = menuItems();
      if (!items.length) return;
      if (target === "last") {
        items[items.length - 1]?.focus();
        return;
      }
      const selected = items.find(
        (item) => item.getAttribute("aria-checked") === "true",
      );
      (selected ?? items[0])?.focus();
    });
  }, [menuItems, menuOpen, menuPosition]);

  useEffect(() => {
    closeMenu();
  }, [activeSessionId, closeMenu]);

  useLayoutEffect(() => {
    if (!activeTabId) return;
    tabButtonRefs.current[activeTabId]?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [activeTabId, tabs.length]);

  const selectTool = useCallback(
    (item: WorkPanelTool, restoreFocus = true) => {
      const existing = tabs.find((tab) => tab.id === item.tab.id);
      if (existing) activateTab(existing.id);
      else openWorkPanelTab(item.tab);
      if (restoreFocus) closeMenu(true);
    },
    [activateTab, closeMenu, openWorkPanelTab, tabs],
  );

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    menuOpenFocus.current = event.key === "ArrowUp" ? "last" : "active";
    setMenuOpen(true);
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    const items = menuItems();
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    let next = current;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % items.length;
    else if (event.key === "ArrowUp") {
      next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
    }
    items[next]?.focus();
  };

  const closeTabAndFocus = useCallback(
    (tabId: string) => {
      const index = tabs.findIndex((tab) => tab.id === tabId);
      const nextTab = index >= 0 ? tabs[index + 1] ?? tabs[index - 1] : undefined;
      closeTab(tabId);
      requestAnimationFrame(() => {
        if (nextTab) tabButtonRefs.current[nextTab.id]?.focus();
        else newTabButtonRef.current?.focus();
      });
    },
    [closeTab, tabs],
  );

  const onTabKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, tabId: string) => {
      const index = tabs.findIndex((tab) => tab.id === tabId);
      if (index < 0) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        closeTabAndFocus(tabId);
        return;
      }
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : event.key === "ArrowLeft"
              ? (index - 1 + tabs.length) % tabs.length
              : (index + 1) % tabs.length;
      const nextTab = tabs[nextIndex];
      if (!nextTab) return;
      activateTab(nextTab.id);
      requestAnimationFrame(() => tabButtonRefs.current[nextTab.id]?.focus());
    },
    [activateTab, closeTabAndFocus, tabs],
  );

  const onTabStripWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const strip = event.currentTarget;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    if (strip.scrollWidth <= strip.clientWidth) return;
    strip.scrollLeft += event.deltaY;
    event.preventDefault();
  };

  const finishPanelResize = useCallback(
    (target: HTMLDivElement, pointerId: number, cancelled: boolean) => {
      const drag = panelResizeState.current;
      if (drag?.pointerId !== pointerId) return;
      panelResizeState.current = null;
      if (drag.frame) cancelAnimationFrame(drag.frame);
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      setPanelDragWidth(null);
      if (!cancelled && drag.currentWidth !== drag.startWidth) {
        setWidth(drag.currentWidth);
      }
    },
    [setWidth],
  );

  const onPanelResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || panelResizeState.current) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.focus({ preventScroll: true });
      const startWidth = clampWorkPanelWidth(width);
      panelResizeState.current = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startWidth,
        currentWidth: startWidth,
        frame: 0,
      };
      setPanelDragWidth(startWidth);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [width],
  );

  const onPanelResizeMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = panelResizeState.current;
    if (drag?.pointerId !== event.pointerId) return;
    drag.currentWidth = clampWorkPanelWidth(
      drag.startWidth + drag.startClientX - event.clientX,
    );
    if (drag.frame) return;
    drag.frame = requestAnimationFrame(() => {
      if (panelResizeState.current !== drag) return;
      drag.frame = 0;
      setPanelDragWidth(drag.currentWidth);
    });
  }, []);

  const onPanelResizeCommit = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      finishPanelResize(event.currentTarget, event.pointerId, false);
    },
    [finishPanelResize],
  );

  const onPanelResizeCancel = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      finishPanelResize(event.currentTarget, event.pointerId, true);
    },
    [finishPanelResize],
  );

  useEffect(
    () => () => {
      const drag = panelResizeState.current;
      if (drag?.frame) cancelAnimationFrame(drag.frame);
      panelResizeState.current = null;
      document.documentElement.removeAttribute("data-work-panel-resizing");
    },
    [],
  );

  const onPanelResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const drag = panelResizeState.current;
      if (event.key === "Escape" && drag) {
        event.preventDefault();
        finishPanelResize(event.currentTarget, drag.pointerId, true);
        return;
      }
      const step = event.shiftKey ? 32 : 16;
      let nextWidth: number | null = null;
      if (event.key === "ArrowLeft") nextWidth = width + step;
      else if (event.key === "ArrowRight") nextWidth = width - step;
      else if (event.key === "Home") nextWidth = WORK_PANEL_MIN_WIDTH;
      else if (event.key === "End") nextWidth = WORK_PANEL_MAX_WIDTH;
      if (nextWidth === null) return;
      event.preventDefault();
      setWidth(clampWorkPanelWidth(nextWidth));
    },
    [finishPanelResize, setWidth, width],
  );

  const activePluginView =
    activeTab?.kind === "plugin"
      ? pluginViews.find((view) => view.ref === activeTab.resource)
      : undefined;
  const activeLabel = activeTab
    ? tabLabel(activeTab, t, pluginViews)
    : t("panel.title");
  const exitAnimationReady = exiting && nativeSurfaceReadyForExit;
  const panelStyle = {
    width: renderPanelWidth,
    "--work-panel-width": `${renderPanelWidth}px`,
  } as CSSProperties;

  return (
    <aside
      className={cx(
        "work-panel",
        exiting && !exitAnimationReady && "is-exit-pending",
        exitAnimationReady && "is-exiting",
      )}
      style={panelStyle}
      data-testid="work-panel"
      data-resizing={isResizing ? "true" : undefined}
      data-exiting={exiting ? "true" : undefined}
      onAnimationEnd={(event) => {
        if (!exitAnimationReady) return;
        if (event.target !== event.currentTarget) return;
        if (!event.animationName.startsWith("work-panel-out")) return;
        onExitAnimationEnd?.();
      }}
    >
      <div
        className="work-panel-resize no-drag"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("panel.resize")}
        aria-valuemin={WORK_PANEL_MIN_WIDTH}
        aria-valuemax={WORK_PANEL_MAX_WIDTH}
        aria-valuenow={Math.round(panelDragWidth ?? renderPanelWidth)}
        tabIndex={0}
        onPointerDown={onPanelResizeStart}
        onPointerMove={onPanelResizeMove}
        onPointerUp={onPanelResizeCommit}
        onPointerCancel={onPanelResizeCancel}
        onLostPointerCapture={onPanelResizeCancel}
        onKeyDown={onPanelResizeKeyDown}
      />
      <div className="work-panel-main">
        <header className="work-panel-header">
          <div className="work-panel-tab-strip-wrap no-drag">
            {subagentPanel ? (
              <div className="work-panel-subagent-heading" aria-label={t("panel.subagent")}>
                <IconBot size={15} />
                <span>{t("panel.subagent")}</span>
              </div>
            ) : (
              <div
                className="work-panel-tab-strip"
                role="tablist"
                aria-label={t("panel.tabsLabel")}
                onWheel={onTabStripWheel}
              >
                {tabs.map((tab) => {
                  const label = tabLabel(tab, t, pluginViews);
                  const selected = tab.id === activeTabId;
                  const Icon =
                    tab.kind === "plugin"
                      ? pluginViewIcon(
                          pluginViews.find((view) => view.ref === tab.resource)?.icon,
                        ) ?? TAB_ICONS.plugin
                      : TAB_ICONS[tab.kind];
                  return (
                    <div className={cx("work-panel-tab", selected && "active")} key={tab.id}>
                      <button
                        ref={(node) => {
                          tabButtonRefs.current[tab.id] = node;
                        }}
                        type="button"
                        role="tab"
                        id={`work-panel-tab-${tab.id}`}
                        aria-selected={selected}
                        aria-controls={`work-panel-surface-${tab.id}`}
                        tabIndex={selected ? 0 : -1}
                        className="work-panel-tab-button"
                        title={tab.resource ?? label}
                        onClick={() => activateTab(tab.id)}
                        onAuxClick={(event) => {
                          if (event.button !== 1) return;
                          event.preventDefault();
                          closeTabAndFocus(tab.id);
                        }}
                        onKeyDown={(event) => onTabKeyDown(event, tab.id)}
                      >
                        <Icon size={14} />
                        <span className="work-panel-tab-label">{label}</span>
                      </button>
                      <button
                        type="button"
                        className="work-panel-tab-close"
                        aria-label={t("panel.closeTab", { name: label })}
                        title={t("panel.closeTab", { name: label })}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={() => closeTabAndFocus(tab.id)}
                      >
                        <IconClose size={12} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="work-panel-actions no-drag">
            {subagentPanel && onCloseSubagentPanel ? (
              <TooltipButton
                type="button"
                className="work-panel-subagent-back"
                tooltip={t("panel.subagentClose")}
                ariaLabel={t("panel.subagentClose")}
                onClick={onCloseSubagentPanel}
              >
                <IconChevronLeft size={15} />
              </TooltipButton>
            ) : (
              <TooltipButton
                ref={newTabButtonRef}
                type="button"
                className="work-panel-new-tab"
                tooltip={t("panel.new.open")}
                ariaLabel={t("panel.new.open")}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-controls="work-panel-new-menu"
                onClick={() => setMenuOpen((open) => !open)}
                onKeyDown={onTriggerKeyDown}
              >
                <IconPlus size={16} />
              </TooltipButton>
            )}
          </div>
        </header>
        {!subagentPanel && menuOpen && typeof document !== "undefined"
          ? createPortal(
              <div
                ref={newTabMenuRef}
                id="work-panel-new-menu"
                className={cx("work-panel-new-menu", menuPosition && "is-open")}
                role="menu"
                aria-label={t("panel.toolsAndPanels")}
                onKeyDown={onMenuKeyDown}
                style={
                  menuPosition
                    ? { top: `${menuPosition.top}px`, left: `${menuPosition.left}px` }
                    : undefined
                }
              >
                <div className="work-panel-menu-group" role="group" aria-labelledby="work-panel-menu-tools">
                  <div className="work-panel-menu-title" id="work-panel-menu-tools">
                    {t("panel.toolsAndPanels")}
                  </div>
                  {tools.map((item) => {
                    const open = tabs.some((tab) => tab.id === item.tab.id);
                    const selected = activeTabId === item.tab.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={selected}
                        tabIndex={-1}
                        data-work-panel-menu-item=""
                        className={cx("work-panel-menu-item", selected && "active")}
                        title={item.description ? `${item.label} — ${item.description}` : item.label}
                        onClick={() => selectTool(item)}
                      >
                        <ToolIcon item={item} />
                        <span className="work-panel-menu-label">{item.label}</span>
                        {item.shortcut ? <kbd className="work-panel-menu-shortcut">{item.shortcut}</kbd> : null}
                        {open && !selected ? <span className="work-panel-open-dot" aria-hidden /> : null}
                      </button>
                    );
                  })}
                </div>
              </div>,
              document.body,
            )
          : null}
        <div className="work-panel-body">
          {subagentPanel ? <SubagentPanel selection={subagentPanel} /> : null}
          {!subagentPanel && activeTab?.kind === "review" && (
            <div
              id={`work-panel-surface-${activeTab.id}`}
              className="work-panel-tabpane"
              role="tabpanel"
              aria-labelledby={`work-panel-tab-${activeTab.id}`}
            >
              <ReviewTab />
            </div>
          )}
          {!subagentPanel && activeTab?.kind === "file" && (
            <div
              key={activeTab.id}
              id={`work-panel-surface-${activeTab.id}`}
              className="work-panel-tabpane"
              role="tabpanel"
              aria-labelledby={`work-panel-tab-${activeTab.id}`}
            >
              <FilesTab />
            </div>
          )}
          {!subagentPanel &&
            activeTab?.kind === "plugin" &&
            (() => {
              const ref = parsePluginViewRef(activeTab.resource);
              if (!ref) return null;
              return (
                <div
                  key={activeTab.id}
                  id={`work-panel-surface-${activeTab.id}`}
                  className="work-panel-tabpane"
                  role="tabpanel"
                  aria-labelledby={`work-panel-tab-${activeTab.id}`}
                >
                  <PluginViewTab
                    pluginId={ref.pluginId}
                    viewId={ref.viewId}
                    title={activeLabel}
                    icon={activePluginView?.icon}
                    sessionId={activeSessionId ?? undefined}
                    location={activeTab.location}
                    // Native WebContentsViews composite above renderer content.
                    // Temporarily detach the active plugin surface so the
                    // portaled menu can stay inside the dock instead of being
                    // pushed into the conversation column.
                    blocked={exiting || panelBlocked || menuOpen}
                  />
                </div>
              );
            })()}
          {!subagentPanel && !activeTab && (
            <div className="work-panel-tabpane" data-testid="work-panel-empty">
              <div className="work-panel-launcher">
                <div className="work-panel-launcher-title">{t("panel.new.title")}</div>
                <div
                  className="work-panel-launcher-list"
                  role="group"
                  aria-label={t("panel.toolsAndPanels")}
                >
                  {tools.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className="work-panel-launcher-row"
                      onClick={() => selectTool(item, false)}
                    >
                      <span className="work-panel-launcher-icon" aria-hidden>
                        <ToolIcon item={item} />
                      </span>
                      <span className="work-panel-launcher-label">{item.label}</span>
                      {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
