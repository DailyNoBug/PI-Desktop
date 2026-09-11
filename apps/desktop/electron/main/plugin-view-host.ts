import { session, shell, WebContentsView, type BrowserWindow } from "electron";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { parseAllowedExternalUrl } from "./safe-open-external";
import {
  applyPluginEgressPolicy,
  pluginSessionPartition,
  type PluginPanelBlockedRequest,
} from "./plugin-panel-host";
import {
  PLUGIN_PANEL_EMBEDDED_ARGUMENT,
  PLUGIN_PANEL_LOCALE_ARGUMENT_PREFIX,
  type PluginPanelTheme,
} from "../shared/plugin-panel-chrome";
import type {
  PluginViewModalGeometry,
  PluginViewRect,
} from "../shared/plugin-view-modal";

/**
 * Plugin-contributed work panel views (ADR 0104).
 *
 * A view is the same isolated web page as a `ui.panel` window — sandboxed
 * preload, per-plugin persisted partition, `net.domains` egress allowlist — but
 * composited inside the main window at a rect the renderer measures, exactly as
 * `BrowserPane` does for the preview browser. The renderer stays the visibility
 * authority: a `WebContentsView` always draws above renderer content, so it
 * must be hidden whenever the view is not the active panel surface or a
 * blocking overlay is open.
 *
 * Views are cached rather than destroyed on tab switch so a plugin keeps its
 * scroll position and in-page state, bounded by `MAX_LIVE_VIEWS` so a user who
 * browses many plugins does not accumulate renderer processes forever.
 */

/** Live views kept warm; the least recently shown one is evicted past this. */
const MAX_LIVE_VIEWS = 4;

/** Keeps the expanded surface clear of the window edge and native controls. */
const VIEW_MODAL_MARGIN = 24;

export type PluginViewOpenRequest = {
  pluginId: string;
  viewId: string;
  locale: string;
  theme: PluginPanelTheme;
  /** Absolute path to the view's HTML entry. */
  htmlPath: string;
  /** Egress allowlist from `manifest.net.domains`. */
  netDomains?: readonly string[];
};

export type PluginViewBounds = PluginViewRect;

type LiveView = {
  key: string;
  pluginId: string;
  view: WebContentsView;
  modal: boolean;
  /** Monotonic counter; lowest value is the least recently shown. */
  usedAt: number;
};

export function pluginViewKey(pluginId: string, viewId: string): string {
  return `${pluginId}/${viewId}`;
}

export class PluginViewHost {
  private views = new Map<string, LiveView>();
  private window: BrowserWindow | null = null;
  /** The one view currently attached to the window, if any. */
  private visibleKey: string | null = null;
  private bounds: PluginViewBounds = { x: 0, y: 0, width: 0, height: 0 };
  private clock = 0;
  private onBlockedRequest?: PluginPanelBlockedRequest;
  private readonly onWindowResize = () => this.syncVisibleBounds();

  constructor(onBlockedRequest?: PluginPanelBlockedRequest) {
    this.onBlockedRequest = onBlockedRequest;
  }

  /**
   * Fired when the visible plugin view changes. The work-panel browser guest
   * clamps itself to this rect so it cannot cover chat/composer.
   */
  onSurface?: (
    surface: {
      pluginId: string;
      viewId: string;
      visible: boolean;
      bounds: PluginViewBounds;
    } | null,
  ) => void;

  /**
   * Push a one-way event to every live docked view. Detached panel windows
   * are broadcast separately by `PluginPanelHost`; both surfaces share the
   * preload channel `pi-plugin-panel-event:<event>`.
   */
  broadcast(event: string, payload: unknown): void {
    const channel = `pi-plugin-panel-event:${event}`;
    for (const entry of this.views.values()) {
      const wc = entry.view.webContents;
      if (wc.isDestroyed()) continue;
      wc.send(channel, payload);
    }
  }

  setWindow(window: BrowserWindow | null): void {
    if (this.window === window) return;
    if (this.window && !this.window.isDestroyed()) {
      this.window.off("resize", this.onWindowResize);
    }
    this.detachVisible();
    this.window = window;
    if (window && !window.isDestroyed()) {
      window.on("resize", this.onWindowResize);
    }
  }

  /** Whether a live web contents exists for this view. */
  has(pluginId: string, viewId: string): boolean {
    return this.views.has(pluginViewKey(pluginId, viewId));
  }

  /**
   * The plugin owning a web contents, so `PluginPanelHost` can accept bridge
   * calls from docked views on the same channel it serves panel windows.
   */
  pluginIdForSender(senderId: number): string | null {
    for (const entry of this.views.values()) {
      const wc = entry.view.webContents;
      if (!wc.isDestroyed() && wc.id === senderId) return entry.pluginId;
    }
    return null;
  }

  prepareModalForSender(pluginId: string, senderId: number): PluginViewModalGeometry {
    const entry = this.visibleEntryForSender(pluginId, senderId);
    return this.modalGeometry();
  }

  setModalForSender(
    pluginId: string,
    senderId: number,
    modal: boolean,
  ): PluginViewModalGeometry {
    const entry = this.liveEntryForSender(pluginId, senderId);
    entry.modal = modal && this.visibleKey === entry.key;
    this.syncVisibleBounds();
    return this.modalGeometry();
  }

  /**
   * Create the view if needed and mark it as the most recently used. Nothing is
   * attached here: the renderer follows with `setBounds` / `setVisible` once it
   * has measured the panel surface.
   */
  open(request: PluginViewOpenRequest): void {
    const key = pluginViewKey(request.pluginId, request.viewId);
    const existing = this.views.get(key);
    if (existing) {
      existing.usedAt = ++this.clock;
      return;
    }
    const view = this.createView(request);
    this.views.set(key, {
      key,
      pluginId: request.pluginId,
      view,
      modal: false,
      usedAt: ++this.clock,
    });
    void view.webContents
      .loadURL(pathToFileURL(request.htmlPath).toString())
      .catch(() => {
        // Load failures surface to the user as the tab's empty state; the view
        // stays cached so a plugin reload can retry into the same slot.
      });
    this.evictBeyondLimit();
  }

  setBounds(bounds: PluginViewBounds): void {
    this.bounds = {
      x: Math.max(0, Math.round(Number(bounds.x) || 0)),
      y: Math.max(0, Math.round(Number(bounds.y) || 0)),
      width: Math.max(0, Math.round(Number(bounds.width) || 0)),
      height: Math.max(0, Math.round(Number(bounds.height) || 0)),
    };
    this.syncVisibleBounds();
  }

  /**
   * Show exactly one view, or none.
   *
   * Only one work panel surface is on screen at a time, so showing a view
   * implicitly detaches whichever was attached before. That keeps a stale view
   * from lingering above the renderer when the user switches tabs quickly.
   */
  setVisible(pluginId: string, viewId: string, visible: boolean): void {
    const key = pluginViewKey(pluginId, viewId);
    if (!visible) {
      if (this.visibleKey === key) this.detachVisible();
      return;
    }
    const entry = this.views.get(key);
    if (!entry) return;
    if (this.visibleKey && this.visibleKey !== key) this.detachVisible();
    entry.usedAt = ++this.clock;
    if (!this.window || this.window.isDestroyed()) return;
    const children = this.window.contentView.children;
    if (!children.includes(entry.view)) {
      this.window.contentView.addChildView(entry.view);
    }
    this.visibleKey = key;
    this.syncVisibleBounds();
    this.sendVisibility(entry, true);
    this.emitSurface();
  }

  close(pluginId: string, viewId: string): void {
    this.destroy(pluginViewKey(pluginId, viewId));
  }

  /** Drop every view a plugin owns — disable, uninstall, reload, or crash. */
  closePlugin(pluginId: string): void {
    for (const [key, entry] of [...this.views]) {
      if (entry.pluginId === pluginId) this.destroy(key);
    }
  }

  dispose(): void {
    for (const key of [...this.views.keys()]) this.destroy(key);
  }

  private destroy(key: string): void {
    const entry = this.views.get(key);
    if (!entry) return;
    if (this.visibleKey === key) this.detachVisible();
    this.views.delete(key);
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
  }

  private detachVisible(): void {
    const entry = this.visibleKey ? this.views.get(this.visibleKey) : null;
    this.visibleKey = null;
    if (entry) entry.modal = false;
    if (entry && this.window && !this.window.isDestroyed()) {
      const children = this.window.contentView.children;
      if (children.includes(entry.view)) {
        this.window.contentView.removeChildView(entry.view);
      }
      this.sendVisibility(entry, false);
    }
    this.emitSurface();
  }

  private sendVisibility(entry: LiveView, visible: boolean): void {
    const wc = entry.view.webContents;
    if (wc.isDestroyed()) return;
    wc.send("pi-plugin-panel-event:view:visibility", {
      pluginId: entry.pluginId,
      visible,
    });
  }

  private liveEntryForSender(pluginId: string, senderId: number): LiveView {
    for (const entry of this.views.values()) {
      const wc = entry.view.webContents;
      if (!wc.isDestroyed() && wc.id === senderId) {
        if (entry.pluginId !== pluginId) break;
        return entry;
      }
    }
    throw invalidViewModalRequest();
  }

  private visibleEntryForSender(pluginId: string, senderId: number): LiveView {
    const entry = this.liveEntryForSender(pluginId, senderId);
    if (this.visibleKey !== entry.key) throw invalidViewModalRequest();
    return entry;
  }

  private modalGeometry(): PluginViewModalGeometry {
    return { dock: this.bounds, modal: this.modalBounds() };
  }

  private modalBounds(): PluginViewRect {
    if (!this.window || this.window.isDestroyed()) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
    const [width, height] = this.window.getContentSize();
    return {
      x: VIEW_MODAL_MARGIN,
      y: VIEW_MODAL_MARGIN,
      width: Math.max(0, width - VIEW_MODAL_MARGIN * 2),
      height: Math.max(0, height - VIEW_MODAL_MARGIN * 2),
    };
  }

  private boundsFor(entry: LiveView): PluginViewRect {
    return entry.modal ? this.modalBounds() : this.bounds;
  }

  private syncVisibleBounds(): void {
    const entry = this.visibleKey ? this.views.get(this.visibleKey) : null;
    if (!entry || !this.window || this.window.isDestroyed()) return;
    entry.view.setBounds(this.boundsFor(entry));
    if (entry.modal) this.sendModalGeometry(entry);
    this.emitSurface();
  }

  private sendModalGeometry(entry: LiveView): void {
    const wc = entry.view.webContents;
    if (wc.isDestroyed()) return;
    wc.send(
      "pi-plugin-panel-event:view:modal-geometry",
      this.modalGeometry(),
    );
  }

  private emitSurface(): void {
    if (!this.onSurface) return;
    if (!this.visibleKey) {
      this.onSurface(null);
      return;
    }
    const entry = this.visibleKey ? this.views.get(this.visibleKey) : null;
    if (!entry) {
      this.onSurface(null);
      return;
    }
    const separator = this.visibleKey.indexOf("/");
    if (separator <= 0) {
      this.onSurface(null);
      return;
    }
    this.onSurface({
      pluginId: this.visibleKey.slice(0, separator),
      viewId: this.visibleKey.slice(separator + 1),
      visible: true,
      bounds: this.boundsFor(entry),
    });
  }

  /** Evict least-recently-shown views, never the one currently on screen. */
  private evictBeyondLimit(): void {
    while (this.views.size > MAX_LIVE_VIEWS) {
      const candidates = [...this.views.values()]
        .filter((entry) => entry.key !== this.visibleKey)
        .sort((a, b) => a.usedAt - b.usedAt);
      const oldest = candidates[0];
      if (!oldest) return;
      this.destroy(oldest.key);
    }
  }

  private createView(request: PluginViewOpenRequest): WebContentsView {
    const ses = session.fromPartition(pluginSessionPartition(request.pluginId), {
      cache: true,
    });
    applyPluginEgressPolicy(ses, {
      pluginId: request.pluginId,
      netDomains: request.netDomains,
      onBlockedRequest: this.onBlockedRequest,
    });

    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        preload: join(__dirname, "../preload/plugin-panel.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        additionalArguments: [
          `${PLUGIN_PANEL_LOCALE_ARGUMENT_PREFIX}${encodeURIComponent(request.locale)}`,
          `--pi-plugin-panel-theme=${request.theme}`,
          PLUGIN_PANEL_EMBEDDED_ARGUMENT,
        ],
      },
    });

    const wc = view.webContents;
    // A docked view gets exactly one web contents. `window.open` would mint a
    // chromeless window outside the egress policy applied above.
    wc.setWindowOpenHandler(({ url }) => {
      const allowed = parseAllowedExternalUrl(url);
      if (allowed) void shell.openExternal(allowed);
      return { action: "deny" };
    });
    return view;
  }
}

function invalidViewModalRequest(): Error {
  return Object.assign(new Error("active docked view required"), {
    code: "INVALID_STATE",
  });
}
