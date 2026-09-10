/**
 * Trusted extensions registry for Electron main (D378, ADR 0207,
 * spec 07-plugins/16-trusted-extensions.md §3, §9, §10, §11).
 *
 * Owns discovery, per-entry enablement in `<dataDir>/trusted-extensions.json`,
 * the command and diagnostics published by each session's sidecar Runner,
 * and the modal prompt broker between the sidecar and the renderer. Nothing
 * here loads or executes extension code; that stays in the sidecar.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import {
  discoverManualPath,
  discoverTrustedExtensions,
} from "@pi-desktop/agent-runtime";
import {
  ErrorCodes,
  TRUSTED_EXTENSION_PROMPT_TIMEOUT_MS,
  type TrustedExtensionCommand,
  type TrustedExtensionDiagnostic,
  type TrustedExtensionEntry,
  type TrustedExtensionEntryState,
  type TrustedExtensionLoadReport,
  type TrustedExtensionScope,
  type TrustedExtensionSource,
  type TrustedExtensionSpec,
  type TrustedExtensionStatusEvent,
  type TrustedExtensionUiPrompt,
  type TrustedExtensionUiRequestEnvelope,
  type TrustedExtensionUiResponse,
  type TrustedExtensionsListResult,
} from "@pi-desktop/shared";

type StoredEntry = {
  enabled: boolean;
  scope: TrustedExtensionScope;
  entry: string;
  label: string;
  source: TrustedExtensionSource;
  root: string;
};

type StoreFile = {
  version: 1;
  entries: Record<string, StoredEntry>;
  manualPaths: string[];
};

type SessionState = {
  commands: TrustedExtensionCommand[];
  diagnostics: TrustedExtensionDiagnostic[];
  reports: TrustedExtensionLoadReport[];
};

type PendingPrompt = {
  sessionId: string;
  kind: "confirm" | "select" | "input";
  resolve: (response: TrustedExtensionUiResponse) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type TrustedExtensionsRegistryOptions = {
  storePath: string;
  /** `~/.pi/agent`; user extensions live in its `extensions` subdirectory. */
  agentDir: string;
  /** Renderer notifications. `hasRenderer` false means prompts fail closed (spec §9). */
  hasRenderer: () => boolean;
  onChanged: () => void;
  onPrompt: (prompt: TrustedExtensionUiPrompt) => void;
  onToast: (message: string, level: "info" | "warning" | "error") => void;
  onStatus: (event: TrustedExtensionStatusEvent) => void;
  promptTimeoutMs?: number;
};

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function sameProject(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return safeRealpath(a) === safeRealpath(b);
}

function scopeFor(spec: TrustedExtensionSpec, projectPath?: string): TrustedExtensionScope {
  if (spec.source === "project") return { project: safeRealpath(projectPath ?? spec.root) };
  return spec.source;
}

function scopeVisible(scope: TrustedExtensionScope, projectPath?: string): boolean {
  if (typeof scope === "string") return true;
  return sameProject(scope.project, projectPath);
}

function dismissedResponse(kind: PendingPrompt["kind"]): TrustedExtensionUiResponse {
  return kind === "confirm" ? { kind, value: false } : { kind, value: undefined };
}

export class TrustedExtensionsRegistry {
  private readonly options: TrustedExtensionsRegistryOptions;
  private store: StoreFile;
  private readonly sessions = new Map<string, SessionState>();
  private readonly pending = new Map<string, PendingPrompt>();
  /** One interactive prompt per session at a time (spec §9). */
  private readonly promptQueues = new Map<string, Promise<unknown>>();

  constructor(options: TrustedExtensionsRegistryOptions) {
    this.options = options;
    this.store = this.readStore();
  }

  // --- enablement -----------------------------------------------------------

  list(projectPath?: string | null): TrustedExtensionsListResult {
    const project = projectPath?.trim() || undefined;
    const discovered = discoverTrustedExtensions({
      agentDir: this.options.agentDir,
      projectPath: project,
      manualPaths: this.store.manualPaths,
    });
    const seen = new Set<string>();
    const entries: TrustedExtensionEntry[] = [];
    for (const spec of discovered) {
      seen.add(spec.id);
      const stored = this.store.entries[spec.id];
      const scope = stored?.scope ?? scopeFor(spec, project);
      entries.push(this.entryFor(spec, stored?.enabled === true, scope, false));
    }
    // Enabled entries that vanished from disk stay listed as missing until
    // the user removes them (spec §3.2).
    for (const [id, stored] of Object.entries(this.store.entries)) {
      if (seen.has(id) || !scopeVisible(stored.scope, project)) continue;
      if (!stored.enabled && !existsSync(stored.entry)) continue;
      entries.push(
        this.entryFor(
          { id, entry: stored.entry, label: stored.label, source: stored.source, root: stored.root },
          stored.enabled,
          stored.scope,
          !existsSync(stored.entry),
        ),
      );
    }
    return {
      entries,
      roots: {
        user: resolve(this.options.agentDir, "extensions"),
        ...(project ? { project: resolve(project, ".pi", "extensions") } : {}),
        manual: [...this.store.manualPaths],
      },
    };
  }

  setEnabled(id: string, enabled: boolean, projectPath?: string | null): TrustedExtensionEntry {
    const project = projectPath?.trim() || undefined;
    const known = this.list(project).entries.find((entry) => entry.id === id);
    if (!known) {
      throw Object.assign(new Error("extension not found"), { errorCode: ErrorCodes.NOT_FOUND });
    }
    if (enabled && known.missing) {
      throw Object.assign(new Error("extension entry file is missing"), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    this.store.entries[id] = {
      enabled,
      scope: known.scope,
      entry: known.entry,
      label: known.label,
      source: known.source,
      root: known.root,
    };
    this.writeStore();
    this.options.onChanged();
    return { ...known, enabled, state: enabled ? known.state : "disabled" };
  }

  /** Re-run discovery. Never flips an enabled flag; drops orphaned disabled rows. */
  rescan(projectPath?: string | null): TrustedExtensionsListResult {
    for (const [id, stored] of Object.entries(this.store.entries)) {
      if (!stored.enabled && !existsSync(stored.entry)) delete this.store.entries[id];
    }
    this.writeStore();
    const result = this.list(projectPath);
    this.options.onChanged();
    return result;
  }

  addPath(path: string): TrustedExtensionsListResult {
    const resolved = resolve(path);
    if (discoverManualPath(resolved).length === 0) {
      throw Object.assign(new Error("no extension entry found at that path"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    if (!this.store.manualPaths.includes(resolved)) {
      this.store.manualPaths.push(resolved);
      this.writeStore();
    }
    const result = this.list();
    this.options.onChanged();
    return result;
  }

  /** Forget a stored entry, and its manual source when nothing else uses it. */
  remove(id: string): void {
    const stored = this.store.entries[id];
    delete this.store.entries[id];
    if (stored?.source === "manual") {
      const stillUsed = Object.values(this.store.entries).some(
        (entry) => entry.source === "manual" && entry.root === stored.root,
      );
      if (!stillUsed) {
        this.store.manualPaths = this.store.manualPaths.filter(
          (path) => path !== stored.root && path !== stored.entry,
        );
      }
    }
    this.writeStore();
    this.options.onChanged();
  }

  /** Specs the sidecar loads for a session in `projectPath` (spec §3.2). */
  enabledSpecsFor(projectPath?: string | null): TrustedExtensionSpec[] {
    const project = projectPath?.trim() || undefined;
    return this.list(project)
      .entries.filter((entry) => entry.enabled && !entry.missing)
      .map((entry) => ({
        id: entry.id,
        entry: entry.entry,
        label: entry.label,
        source: entry.source,
        root: entry.root,
      }));
  }

  // --- sidecar publications ---------------------------------------------------

  publishCommands(sessionId: string, commands: TrustedExtensionCommand[]): void {
    this.session(sessionId).commands = commands;
    this.options.onChanged();
  }

  publishDiagnostics(
    sessionId: string,
    diagnostics: TrustedExtensionDiagnostic[],
    reports: TrustedExtensionLoadReport[],
  ): void {
    const state = this.session(sessionId);
    state.diagnostics = diagnostics;
    if (reports.length) state.reports = reports;
    this.options.onChanged();
  }

  /** Commands registered by any live session, deduplicated by name. */
  allCommands(): TrustedExtensionCommand[] {
    const byName = new Map<string, TrustedExtensionCommand>();
    for (const state of this.sessions.values()) {
      for (const command of state.commands) {
        if (!byName.has(command.name)) byName.set(command.name, command);
      }
    }
    return [...byName.values()];
  }

  commandsForSession(sessionId: string): TrustedExtensionCommand[] {
    return this.sessions.get(sessionId)?.commands ?? [];
  }

  clearSession(sessionId: string): void {
    this.cancelPrompts(sessionId);
    if (this.sessions.delete(sessionId)) this.options.onChanged();
  }

  // --- UI bridge ------------------------------------------------------------------

  async requestUi(envelope: TrustedExtensionUiRequestEnvelope): Promise<TrustedExtensionUiResponse> {
    const { request } = envelope;
    switch (request.kind) {
      case "notify":
        this.options.onToast(`${envelope.extensionLabel}: ${request.message}`, request.level);
        return { kind: "notify" };
      case "setStatus":
        this.options.onStatus({
          sessionId: envelope.sessionId,
          extensionId: envelope.extensionId,
          key: request.key,
          text: request.text,
        });
        return { kind: "setStatus" };
      case "setWorkingMessage":
        this.options.onStatus({
          sessionId: envelope.sessionId,
          extensionId: envelope.extensionId,
          key: "working",
          text: request.text,
        });
        return { kind: "setWorkingMessage" };
      case "confirm":
      case "select":
      case "input":
        break;
    }
    if (!this.options.hasRenderer()) {
      throw Object.assign(new Error("interactive extension prompts need the desktop window"), {
        errorCode: ErrorCodes.UNSUPPORTED,
      });
    }
    const previous = this.promptQueues.get(envelope.sessionId) ?? Promise.resolve();
    const run = previous.then(() => this.showPrompt(envelope, request));
    this.promptQueues.set(envelope.sessionId, run.catch(() => undefined));
    return run;
  }

  respond(promptId: string, value: string | boolean | undefined): boolean {
    const pending = this.pending.get(promptId);
    if (!pending) return false;
    this.settle(promptId, this.responseFor(pending.kind, value));
    return true;
  }

  /** Aborting a turn dismisses that session's open prompts (spec §9). */
  cancelPrompts(sessionId: string): void {
    for (const [promptId, pending] of this.pending) {
      if (pending.sessionId === sessionId) this.settle(promptId, dismissedResponse(pending.kind));
    }
  }

  pendingPromptCount(): number {
    return this.pending.size;
  }

  // --- internals -------------------------------------------------------------------

  private showPrompt(
    envelope: TrustedExtensionUiRequestEnvelope,
    request: TrustedExtensionUiPrompt["request"],
  ): Promise<TrustedExtensionUiResponse> {
    return new Promise((resolvePrompt) => {
      const promptId = randomUUID();
      const timer = setTimeout(
        () => this.settle(promptId, dismissedResponse(request.kind)),
        this.options.promptTimeoutMs ?? TRUSTED_EXTENSION_PROMPT_TIMEOUT_MS,
      );
      this.pending.set(promptId, {
        sessionId: envelope.sessionId,
        kind: request.kind,
        resolve: resolvePrompt,
        timer,
      });
      this.options.onPrompt({
        promptId,
        sessionId: envelope.sessionId,
        extensionId: envelope.extensionId,
        extensionLabel: envelope.extensionLabel,
        request,
      });
    });
  }

  private settle(promptId: string, response: TrustedExtensionUiResponse): void {
    const pending = this.pending.get(promptId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(promptId);
    pending.resolve(response);
  }

  private responseFor(
    kind: PendingPrompt["kind"],
    value: string | boolean | undefined,
  ): TrustedExtensionUiResponse {
    if (kind === "confirm") return { kind, value: value === true };
    return { kind, value: typeof value === "string" ? value : undefined };
  }

  private session(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { commands: [], diagnostics: [], reports: [] };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  private entryFor(
    spec: TrustedExtensionSpec,
    enabled: boolean,
    scope: TrustedExtensionScope,
    missing: boolean,
  ): TrustedExtensionEntry {
    let state: TrustedExtensionEntryState = enabled ? "loaded" : "disabled";
    let toolNames: string[] = [];
    let commandNames: string[] = [];
    let diagnostics: TrustedExtensionDiagnostic[] = [];
    if (missing) state = "missing";
    else if (enabled) {
      // The most recent session that reported on this entry wins.
      let seenReport = false;
      for (const session of this.sessions.values()) {
        const report = session.reports.find((r) => r.extensionId === spec.id);
        if (!report) continue;
        seenReport = true;
        state = report.state;
        toolNames = report.toolNames;
        commandNames = report.commandNames;
        diagnostics = session.diagnostics.filter((d) => d.extensionId === spec.id);
      }
      if (!seenReport) state = "enabled";
    }
    return {
      id: spec.id,
      entry: spec.entry,
      label: spec.label,
      source: spec.source,
      root: spec.root,
      enabled,
      scope,
      missing,
      state,
      toolNames,
      commandNames,
      diagnostics,
    };
  }

  private readStore(): StoreFile {
    try {
      const parsed = JSON.parse(readFileSync(this.options.storePath, "utf8")) as Partial<StoreFile>;
      return {
        version: 1,
        entries: parsed.entries && typeof parsed.entries === "object" ? parsed.entries : {},
        manualPaths: Array.isArray(parsed.manualPaths)
          ? parsed.manualPaths.filter((p): p is string => typeof p === "string")
          : [],
      };
    } catch {
      return { version: 1, entries: {}, manualPaths: [] };
    }
  }

  private writeStore(): void {
    mkdirSync(dirname(this.options.storePath), { recursive: true });
    writeFileSync(this.options.storePath, JSON.stringify(this.store, null, 2), "utf8");
  }
}
