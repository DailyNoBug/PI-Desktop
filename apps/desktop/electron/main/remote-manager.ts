import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type {
  AgentEventEnvelope,
  AgentPromptAttachment,
  AgentStatus,
  AskToolResolution,
  FsEntry,
  FsReadResult,
  McpServerInput,
  McpServerRecord,
  McpServerStatus,
  PlanProposal,
  ProjectWorkspace,
  QueuedTurnSummary,
  RacpEventEnvelope,
  RacpInitializeResult,
  RacpProjectSummary,
  RacpSession,
  RacpSessionSnapshot,
  RemoteConnection,
  RemoteConnectionInput,
  RemoteConnectionState,
  RemoteConnectionView,
  RemoteDiagnostics,
  RemoteDirectoryResult,
  RemoteHostRuntime,
  RemoteProjectRecord,
  RemoteTerminalEvent,
  RemoteTerminalSnapshot,
  SessionDetail,
  SessionSummary,
  ToolPermissionRequest,
  UiMessage,
  UserSkillInput,
  UserSkillRecord,
  WorkspaceDiff,
} from "@pi-desktop/shared";
import {
  APP_VERSION,
  ErrorCodes,
  PROTOCOL_VERSION,
  RACP_PROTOCOL_VERSION,
  REMOTE_RECONNECT_DELAYS_MS,
  SCHEMA_VERSION,
  isRemoteProjectPath,
  normalizeRemotePath,
  parseRemoteProjectUri,
  protocolVersionsCompatible,
  remoteProjectUri,
  validateRemoteConnectionInput,
} from "@pi-desktop/shared";
import { RacpWsClient, type RacpClientEvent } from "@pi-desktop/agent-host";
import { RemoteStore } from "./remote-store";
import {
  acceptHostKeys,
  disposeTunnel,
  discoverSshAliases,
  effectiveSshConfig,
  freeLoopbackPort,
  knownHostAccepted,
  readRemoteRuntimeMetadata,
  runSshScript,
  scanHostKeys,
  sshProbe,
  startSshTunnel,
  SshError,
  type SshTunnel,
} from "./ssh";

type HostLike = {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
};

export type RemoteManagerEvents = {
  onAgentEvent: (event: AgentEventEnvelope) => void;
  onConnectionsChanged: () => void;
  onSessionsChanged: () => void;
  onQueueChanged: (event: { sessionId: string; entries: QueuedTurnSummary[] }) => void;
  onTerminalEvent: (event: RemoteTerminalEvent) => void;
  onAudit: (event: string, data?: Record<string, unknown>) => void;
};

type RemoteRuntime = {
  connection: RemoteConnection;
  state: RemoteConnectionState;
  host?: RemoteHostRuntime;
  client?: RacpWsClient;
  tunnel?: SshTunnel;
  explicitDisconnect: boolean;
  connecting?: Promise<void>;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  reconnectAttempt: number;
  lastError?: RemoteConnectionView["lastError"];
  lastExitCode?: number | null;
  sessionCursors: Map<string, { epoch: string; sequence: number }>;
  sessionSubscriptions: Map<string, string>;
  hostSubscription?: string;
  activeTurns: Map<string, string>;
  sessionProjects: Map<string, string>;
  terminals: Map<string, string>;
};

const NON_RETRYABLE_REMOTE_CODES = new Set<string>([
  ErrorCodes.SSH_NOT_AVAILABLE,
  ErrorCodes.SSH_CONFIG_NOT_FOUND,
  ErrorCodes.SSH_HOST_NOT_FOUND,
  ErrorCodes.SSH_AUTH_FAILED,
  ErrorCodes.SSH_HOST_KEY_FAILED,
  ErrorCodes.REMOTE_OS_UNSUPPORTED,
  ErrorCodes.REMOTE_ARCH_UNSUPPORTED,
  ErrorCodes.REMOTE_CHECKSUM_MISMATCH,
  ErrorCodes.REMOTE_HOST_VERSION_INCOMPATIBLE,
  ErrorCodes.REMOTE_PROTOCOL_MISMATCH,
  ErrorCodes.REMOTE_TOKEN_REVOKED,
  ErrorCodes.UNAUTHORIZED,
  ErrorCodes.FORBIDDEN,
  ErrorCodes.PROTOCOL_MISMATCH,
]);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function tokenRef(hostId: string): string {
  return `remote-host:${hostId}:device-token`;
}

function publicError(error: unknown, stage: RemoteConnectionState): RemoteConnectionView["lastError"] {
  const code = (error as { errorCode?: string; code?: string }).errorCode ?? (error as { code?: string }).code ?? ErrorCodes.REMOTE_BOOTSTRAP_FAILED;
  return {
    code: typeof code === "string" ? code : ErrorCodes.REMOTE_BOOTSTRAP_FAILED,
    message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
    stage,
    at: new Date().toISOString(),
  };
}

function exitCodeOf(error: unknown): number | null | undefined {
  const value = (error as { exitCode?: unknown }).exitCode;
  return typeof value === "number" ? value : null;
}

function toIpcError(error: unknown): Error & { errorCode?: string; details?: unknown } {
  if (error instanceof Error) {
    const next = error as Error & { errorCode?: string; details?: unknown };
    if (!next.errorCode && (next as { code?: unknown }).code) next.errorCode = String((next as { code?: unknown }).code);
    return next;
  }
  return Object.assign(new Error(String(error)), { errorCode: ErrorCodes.REMOTE_HOST_UNAVAILABLE });
}

function bootstrapScriptPath(): string {
  const candidates = [
    process.env.PI_DESKTOP_PI_HOST_BOOTSTRAP,
    join(process.resourcesPath || "", "pi-host/bootstrap.sh"),
    join(__dirname, "../../../scripts/pi-host-bootstrap.sh"),
    join(__dirname, "../../../../scripts/pi-host-bootstrap.sh"),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw Object.assign(new Error("pi-host bootstrap script not found"), { errorCode: ErrorCodes.REMOTE_BOOTSTRAP_FAILED });
}

async function releaseChecksum(version: string, arch: "x64" | "arm64"): Promise<string> {
  const name = `pi-host-${version}-linux-${arch}.tar.gz.sha256`;
  const url = `https://github.com/vastsa/PI-Desktop/releases/download/v${version}/${name}`;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`GitHub Releases returned ${response.status}`);
    const body = await response.text();
    const match = body.match(/\b[0-9a-f]{64}\b/);
    if (!match) throw new Error("release checksum is missing");
    return match[0];
  } catch (error) {
    throw Object.assign(new Error(`could not fetch pi-host checksum: ${error instanceof Error ? error.message : String(error)}`), {
      errorCode: ErrorCodes.REMOTE_DOWNLOAD_FAILED,
    });
  }
}

function parseBootstrapOutput(stdout: string): { ready?: Record<string, unknown>; metadata?: Record<string, unknown> } {
  const result: { ready?: Record<string, unknown>; metadata?: Record<string, unknown> } = {};
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value = JSON.parse(trimmed) as Record<string, unknown>;
      if (value.event === "pi-host.ready") result.ready = value;
      else if (typeof value.pid === "number" && typeof value.port === "number") result.metadata = value;
    } catch {
      // Bootstrap also echoes the pretty host.json document line by line.
    }
  }
  return result;
}

function remoteArch(value: string): "x64" | "arm64" {
  if (value === "x86_64" || value === "amd64") return "x64";
  if (value === "aarch64" || value === "arm64") return "arm64";
  throw Object.assign(new Error(`unsupported remote architecture: ${value}`), {
    errorCode: ErrorCodes.REMOTE_ARCH_UNSUPPORTED,
  });
}

function thinkingLevel(value: unknown): SessionSummary["thinkingLevel"] {
  return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max"
    ? value
    : "off";
}

function activeTurnStatus(session: RacpSessionSnapshot, runtime: RemoteRuntime): AgentStatus {
  const active = session.activeTurn;
  if (active) runtime.activeTurns.set(session.session.id, active.id);
  else runtime.activeTurns.delete(session.session.id);
  return {
    sessionId: session.session.id,
    isRunning: Boolean(active),
    ...(active ? { currentTurnId: active.id } : {}),
    pendingToolConfirmations: session.pendingApprovals.filter((approval) => approval.kind === "tool").length,
    ...(session.session.planningState !== "inactive" ? { planningState: session.session.planningState } : {}),
  };
}

/** Electron Main's SSH supervisor and Remote Host adapter. */
export class RemoteManager {
  private readonly runtimes = new Map<string, RemoteRuntime>();
  private readonly sessionRuntimes = new Map<string, string>();
  private readonly turnRuntimes = new Map<string, string>();
  private readonly approvalRuntimes = new Map<string, string>();
  private activeProjectId?: string;
  private disposed = false;

  constructor(
    private readonly store: RemoteStore,
    private readonly getHost: () => HostLike | null,
    private readonly confirmFingerprint: (input: { connection: RemoteConnection; fingerprints: string[] }) => Promise<boolean>,
    private readonly events: RemoteManagerEvents,
  ) {}

  static open(dataDir: string, getHost: () => HostLike | null, confirmFingerprint: RemoteManager["confirmFingerprint"], events: RemoteManagerEvents): RemoteManager {
    return new RemoteManager(new RemoteStore(dataDir), getHost, confirmFingerprint, events);
  }

  async refreshConnections(): Promise<RemoteConnectionView[]> {
    try {
      for (const alias of discoverSshAliases()) {
        this.store.upsertDiscoveredConnection({
          displayName: alias,
          source: "ssh-config",
          sshConfigAlias: alias,
          enabled: true,
        });
      }
    } catch (error) {
      if ((error as { code?: string }).code !== "SSH_CONFIG_NOT_FOUND") throw error;
    }
    return this.listConnections();
  }

  listConnections(): RemoteConnectionView[] {
    return this.store.listConnections().map((connection) => {
      const runtime = this.runtimes.get(connection.id);
      const host = this.store.getHost(runtime?.host?.id ?? this.hostIdFor(connection.id));
      return {
        ...connection,
        state: runtime?.state ?? "disconnected",
        ...(host ? { host } : {}),
        ...(runtime?.lastError ? { lastError: runtime.lastError } : {}),
        ...(runtime?.lastExitCode !== undefined ? { lastExitCode: runtime.lastExitCode } : {}),
        ...(runtime?.reconnectAttempt ? { reconnectAttempt: runtime.reconnectAttempt } : {}),
      };
    });
  }

  exportConnections(): string {
    const connections = this.store.listConnections().map((connection) => ({
      displayName: connection.displayName,
      source: connection.source,
      ...(connection.sshConfigAlias ? { sshConfigAlias: connection.sshConfigAlias } : {}),
      ...(connection.hostname ? { hostname: connection.hostname } : {}),
      ...(connection.user ? { user: connection.user } : {}),
      ...(connection.port ? { port: connection.port } : {}),
      ...(connection.identityFilePath ? { identityFilePath: connection.identityFilePath } : {}),
      enabled: connection.enabled,
    }));
    return `${JSON.stringify({ version: 1, connections }, null, 2)}\n`;
  }

  async importConnections(text: string): Promise<{ imported: number; skipped: number }> {
    let parsed: { version?: unknown; connections?: unknown };
    try {
      parsed = JSON.parse(text) as { version?: unknown; connections?: unknown };
    } catch {
      throw Object.assign(new Error("connection export is not valid JSON"), { errorCode: ErrorCodes.INVALID_ARGUMENT });
    }
    if (parsed.version !== 1 || !Array.isArray(parsed.connections)) {
      throw Object.assign(new Error("connection export version or shape is invalid"), { errorCode: ErrorCodes.INVALID_ARGUMENT });
    }
    let imported = 0;
    let skipped = 0;
    for (const raw of parsed.connections.slice(0, 256)) {
      const validated = validateRemoteConnectionInput(raw as Partial<RemoteConnectionInput>);
      if (!validated.ok) {
        skipped += 1;
        continue;
      }
      const input = validated.value;
      const existing = this.store.listConnections().find((connection) =>
        input.source === "ssh-config"
          ? connection.source === "ssh-config" && connection.sshConfigAlias === input.sshConfigAlias
          : connection.source === "managed" &&
            connection.hostname === input.hostname &&
            (connection.user ?? "") === (input.user ?? "") &&
            (connection.port ?? 22) === (input.port ?? 22),
      );
      if (existing) await this.updateConnection(existing.id, input);
      else if (input.source === "ssh-config") await this.addConfigConnection(input);
      else await this.addConnection(input);
      imported += 1;
    }
    this.events.onAudit("connection.imported", { imported, skipped });
    this.events.onConnectionsChanged();
    return { imported, skipped };
  }

  async addConnection(input: RemoteConnectionInput): Promise<RemoteConnectionView> {
    const connection = this.store.addManagedConnection(input);
    this.events.onAudit("connection.created", { connectionId: connection.id });
    this.events.onConnectionsChanged();
    return this.viewFor(connection.id);
  }

  async addConfigConnection(input: RemoteConnectionInput): Promise<RemoteConnectionView | undefined> {
    const connection = this.store.upsertDiscoveredConnection(input);
    if (!connection) return undefined;
    this.events.onAudit("connection.created", { connectionId: connection.id });
    this.events.onConnectionsChanged();
    return this.viewFor(connection.id);
  }

  async updateConnection(id: string, input: RemoteConnectionInput): Promise<RemoteConnectionView> {
    if (this.runtimes.get(id)?.client) await this.disconnect(id);
    this.store.updateConnection(id, input);
    this.events.onAudit("connection.updated", { connectionId: id });
    this.events.onConnectionsChanged();
    return this.viewFor(id);
  }

  async removeConnection(id: string): Promise<void> {
    await this.disconnect(id);
    const hostId = this.hostIdFor(id);
    const host = this.getHost();
    if (host) await host.call("secrets.delete", { secretRef: tokenRef(hostId) }).catch(() => undefined);
    this.store.removeConnection(id);
    this.events.onAudit("connection.removed", { connectionId: id });
    this.events.onConnectionsChanged();
  }

  async testConnection(id: string): Promise<{ ok: true; os: string; arch: string; home: string; shell: string }> {
    const connection = this.requireConnection(id);
    this.setState(id, "connecting");
    try {
      const probe = await sshProbe(connection);
      this.events.onAudit("connection.tested", {
        connectionId: id,
        os: probe.os,
        arch: probe.arch,
      });
      this.setState(id, "disconnected");
      return { ok: true, ...probe };
    } catch (error) {
      this.failure(id, error);
      throw toIpcError(error);
    }
  }

  async connect(id: string): Promise<RemoteConnectionView> {
    const runtime = this.runtimeFor(id);
    if (runtime.client) return this.viewFor(id);
    if (runtime.connecting) {
      await runtime.connecting;
      return this.viewFor(id);
    }
    runtime.connecting = this.connectInternal(runtime);
    try {
      await runtime.connecting;
      return this.viewFor(id);
    } catch (error) {
      await this.closeTransport(runtime).catch(() => undefined);
      this.failure(id, error);
      const code = (error as { errorCode?: string; code?: string }).errorCode ?? (error as { code?: string }).code;
      if (!NON_RETRYABLE_REMOTE_CODES.has(String(code))) this.scheduleReconnect(id);
      throw toIpcError(error);
    } finally {
      runtime.connecting = undefined;
    }
  }

  async upgradeHost(id: string): Promise<RemoteConnectionView> {
    const runtime = this.runtimeFor(id);
    if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
    runtime.reconnectTimer = undefined;
    runtime.reconnectAttempt = 0;
    await this.closeTransport(runtime);
    this.setState(id, "bootstrapping");
    try {
      const probe = await sshProbe(runtime.connection);
      if (probe.os !== "Linux") {
        throw Object.assign(new Error(`remote OS ${probe.os || "unknown"} is unsupported; Linux is required`), {
          errorCode: ErrorCodes.REMOTE_OS_UNSUPPORTED,
        });
      }
      const arch = remoteArch(probe.arch);
      const checksum = await releaseChecksum(APP_VERSION, arch);
      const bootstrap = await runSshScript(runtime.connection, readFileSync(bootstrapScriptPath(), "utf8"), {
        PI_HOST_VERSION: APP_VERSION,
        PI_HOST_ARCH: arch,
        PI_HOST_CHECKSUM: checksum,
        PI_HOST_FORCE_RESTART: "1",
      });
      const ready = parseBootstrapOutput(bootstrap.stdout).ready;
      const port = Number(ready?.port ?? 0);
      if (!Number.isInteger(port) || port <= 0) {
        throw Object.assign(new Error(bootstrap.stdout.trim() || "pi-host upgrade returned no endpoint"), {
          errorCode: ErrorCodes.REMOTE_HOST_START_FAILED,
        });
      }
      const pairing = ready?.pairing;
      if (pairing && typeof pairing === "object") {
        const token = String((pairing as { token?: unknown }).token ?? "");
        if (token) await this.writeToken(this.hostIdFor(id), token);
      }
      this.events.onAudit("remote.host.upgraded", {
        connectionId: id,
        version: APP_VERSION,
        arch,
        explicit: true,
      });
      return await this.connect(id);
    } catch (error) {
      await this.closeTransport(runtime).catch(() => undefined);
      this.failure(id, error);
      throw toIpcError(error);
    }
  }

  async disconnect(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    runtime.explicitDisconnect = true;
    if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
    runtime.reconnectTimer = undefined;
    runtime.reconnectAttempt = 0;
    await this.closeTransport(runtime);
    this.setState(id, "disconnected");
    this.events.onAudit("connection.closed", { connectionId: id, explicit: true });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.runtimes.keys()].map((id) => this.disconnect(id)));
  }

  listProjects(): RemoteProjectRecord[] {
    return this.store.listProjects();
  }

  projectWorkspace(projectId: string): ProjectWorkspace | null {
    const project = this.store.getProject(projectId);
    return project ? this.workspaceForProject(project) : null;
  }

  async browseDirectory(input: { connectionId: string; path?: string }): Promise<RemoteDirectoryResult> {
    const runtime = await this.requireConnected(input.connectionId);
    return this.request<RemoteDirectoryResult>(runtime, "workspace/browse", {
      ...(input.path ? { path: input.path } : {}),
    });
  }

  async addProject(input: { connectionId: string; remotePath: string; name?: string }): Promise<ProjectWorkspace> {
    const path = normalizeRemotePath(input.remotePath);
    if (!path) throw Object.assign(new Error("remote path must be absolute"), { errorCode: ErrorCodes.REMOTE_PROJECT_INVALID_PATH });
    const runtime = await this.requireConnected(input.connectionId);
    const directory = await this.request<RemoteDirectoryResult>(runtime, "workspace/browse", { path });
    if (!directory.readable) {
      throw Object.assign(new Error("remote directory is not readable"), { errorCode: ErrorCodes.REMOTE_PROJECT_PERMISSION_DENIED });
    }
    const host = this.requireRuntimeHost(runtime);
    const project = this.store.addProject({
      hostId: host.id,
      connectionId: input.connectionId,
      remotePath: directory.path,
      name: input.name?.trim() || basename(directory.path),
    });
    this.events.onConnectionsChanged();
    this.events.onAudit("remote.project.added", {
      connectionId: input.connectionId,
      hostId: host.id,
      remotePath: directory.path,
    });
    return this.workspaceForProject(project, directory.isGitRepository);
  }

  async openProject(projectId: string): Promise<ProjectWorkspace> {
    const project = this.store.getProject(projectId);
    if (!project) throw Object.assign(new Error("remote project not found"), { errorCode: ErrorCodes.REMOTE_PROJECT_NOT_FOUND });
    await this.connect(project.connectionId);
    this.activeProjectId = project.id;
    this.store.touchProject(project.id);
    this.events.onAudit("remote.project.attached", {
      connectionId: project.connectionId,
      hostId: project.hostId,
      remotePath: project.normalizedRemotePath,
    });
    return this.workspaceForProject(project);
  }

  async openProjectForConnection(
    connectionKey: string,
    remotePath: string,
  ): Promise<ProjectWorkspace> {
    const connection = this.connectionForKey(connectionKey);
    if (!connection) {
      throw Object.assign(new Error(`remote connection not found: ${connectionKey}`), {
        errorCode: ErrorCodes.REMOTE_PROJECT_NOT_FOUND,
      });
    }
    const workspace = await this.addProject({
      connectionId: connection.id,
      remotePath,
    });
    const normalizedRemotePath = normalizeRemotePath(remotePath);
    if (!normalizedRemotePath) throw new Error("invalid remote project path");
    const record = this.store
      .listProjects()
      .find((project) => project.connectionId === connection.id && project.normalizedRemotePath === normalizedRemotePath);
    if (!record) throw new Error("remote project registration failed");
    this.activeProjectId = record.id;
    this.store.touchProject(record.id);
    this.events.onAudit("remote.project.attached", {
      connectionId: connection.id,
      hostId: record.hostId,
      remotePath: record.normalizedRemotePath,
    });
    return workspace;
  }

  async removeProject(projectId: string): Promise<void> {
    const project = this.store.getProject(projectId);
    if (!project) return;
    this.store.removeProject(projectId);
    if (this.activeProjectId === projectId) this.activeProjectId = undefined;
    this.events.onConnectionsChanged();
    this.events.onAudit("remote.project.removed", { projectId });
  }

  getProject(): ProjectWorkspace | null {
    if (!this.activeProjectId) return null;
    const project = this.store.getProject(this.activeProjectId);
    return project ? this.workspaceForProject(project) : null;
  }

  async setProject(path: string): Promise<ProjectWorkspace | null> {
    const parsed = parseRemoteProjectUri(path);
    if (!parsed) return null;
    const connection = this.connectionForKey(parsed.connectionKey);
    if (!connection) throw Object.assign(new Error("remote connection not found"), { errorCode: ErrorCodes.REMOTE_PROJECT_NOT_FOUND });
    const workspace = await this.addProject({
      connectionId: connection.id,
      remotePath: parsed.remotePath,
    });
    const record = this.store
      .listProjects()
      .find((candidate) => candidate.connectionId === connection.id && candidate.normalizedRemotePath === parsed.remotePath);
    if (!record) throw new Error("remote project registration failed");
    this.activeProjectId = record.id;
    this.store.touchProject(record.id);
    return workspace;
  }

  async clearProject(): Promise<void> {
    this.activeProjectId = undefined;
  }

  isRemotePath(path: string | null | undefined): boolean {
    return isRemoteProjectPath(path);
  }

  async listSessions(): Promise<SessionSummary[]> {
    const sessions: SessionSummary[] = [];
    for (const runtime of this.connectedRuntimes()) {
      const [remoteSessions, projects] = await Promise.all([
        this.request<{ sessions: RacpSession[] }>(runtime, "session/list"),
        this.request<{ projects: RacpProjectSummary[] }>(runtime, "project/list"),
      ]);
      const projectPaths = new Map(projects.projects.map((project) => [project.id, project.path]));
      for (const session of remoteSessions.sessions) {
        const projectPath = this.projectPathFor(runtime, session, projectPaths);
        sessions.push(this.toSessionSummary(runtime, session, projectPath));
        await this.subscribeSession(runtime, session.id);
      }
    }
    return sessions;
  }

  knowsSession(sessionId: string): boolean {
    return this.sessionRuntimes.has(sessionId);
  }

  knowsTurn(turnId: string): boolean {
    return this.turnRuntimes.has(turnId);
  }

  knowsApproval(approvalId: string): boolean {
    return this.approvalRuntimes.has(approvalId);
  }

  async resolvePermissionById(approvalId: string, decision: string): Promise<void> {
    const sessionId = this.approvalRuntimes.get(approvalId);
    if (!sessionId) throw Object.assign(new Error("remote approval not found"), { errorCode: ErrorCodes.NOT_FOUND });
    await this.resolvePermission(sessionId, approvalId, decision);
  }

  async createSession(input: Partial<SessionSummary>): Promise<SessionSummary> {
    const projectPath = input.projectPath?.trim();
    if (!projectPath || !isRemoteProjectPath(projectPath)) throw new Error("a remote project path is required");
    const parsed = parseRemoteProjectUri(projectPath)!;
    const connection = this.connectionForKey(parsed.connectionKey);
    if (!connection) throw Object.assign(new Error("remote connection not found"), { errorCode: ErrorCodes.REMOTE_PROJECT_NOT_FOUND });
    const runtime = await this.requireConnected(connection.id);
    const result = await this.request<{ session: RacpSession }>(runtime, "session/create", {
      ...(input.title ? { title: input.title } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.permissionMode && input.permissionMode !== "inherit" ? { permissionMode: input.permissionMode } : {}),
      ...(input.providerId ? { providerId: input.providerId } : {}),
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
      projectPath: parsed.remotePath,
    });
    await this.subscribeSession(runtime, result.session.id);
    this.events.onSessionsChanged();
    return this.toSessionSummary(runtime, result.session, projectPath);
  }

  async getSessionDetail(sessionId: string): Promise<SessionDetail | null> {
    const runtime = this.runtimeForSession(sessionId);
    if (!runtime) return null;
    const attached = await this.request<{ snapshot?: RacpSessionSnapshot }>(runtime, "session/attach", {
      sessionId,
      includeSnapshot: true,
      ...(this.cursor(runtime, sessionId) ? { after: this.cursor(runtime, sessionId) } : {}),
    });
    const snapshot = attached.snapshot;
    if (!snapshot) return null;
    await this.subscribeSession(runtime, sessionId);
    const projectPath = this.sessionProjectPath(runtime, sessionId);
    const summary = this.toSessionSummary(runtime, snapshot.session, projectPath, snapshot.items.length);
    return {
      ...summary,
      messages: snapshot.items.map((item) => item.content as UiMessage),
      hasMoreBefore: snapshot.hasMoreHistory,
    };
  }

  async configureSession(sessionId: string, config: Record<string, unknown>): Promise<SessionSummary> {
    const runtime = this.runtimeForSession(sessionId);
    if (!runtime) throw new Error("session is not remote");
    const result = await this.request<{ session: RacpSession }>(runtime, "session/configure", {
      sessionId,
      ...config,
    });
    return this.toSessionSummary(runtime, result.session, this.sessionProjectPath(runtime, sessionId));
  }

  async forkSession(sessionId: string, title?: string, throughMessageId?: string): Promise<SessionSummary> {
    const runtime = this.runtimeForSession(sessionId);
    if (!runtime) throw new Error("session is not remote");
    const result = await this.request<{ session: RacpSession }>(runtime, "session/fork", {
      sessionId,
      ...(title ? { title } : {}),
      ...(throughMessageId ? { throughMessageId } : {}),
    });
    return this.toSessionSummary(runtime, result.session, this.sessionProjectPath(runtime, sessionId));
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    const runtime = this.runtimeForSession(sessionId);
    if (!runtime) throw new Error("session is not remote");
    await this.request(runtime, "session/rename", { sessionId, title });
  }

  async deleteSession(sessionId: string): Promise<void> {
    const runtime = this.runtimeForSession(sessionId);
    if (!runtime) throw new Error("session is not remote");
    await this.request(runtime, "session/delete", { sessionId });
    this.sessionRuntimes.delete(sessionId);
    runtime.sessionSubscriptions.delete(sessionId);
    runtime.sessionCursors.delete(sessionId);
  }

  async compactSession(sessionId: string): Promise<{ accepted: boolean }> {
    const runtime = this.runtimeForSession(sessionId);
    if (!runtime) throw new Error("session is not remote");
    return this.request(runtime, "session/compact", { sessionId });
  }

  async saveRevision(input: {
    sessionId: string;
    rootUserId: string;
    messages: unknown[];
    makeActive?: boolean;
  }): Promise<{ revision: unknown }> {
    const runtime = this.runtimeForSession(input.sessionId);
    if (!runtime) throw new Error("session is not remote");
    return this.request(runtime, "session/revision/save", {
      sessionId: input.sessionId,
      rootUserId: input.rootUserId,
      messages: input.messages,
      makeActive: input.makeActive === true,
    });
  }

  async listRevisions(sessionId: string, rootUserId: string): Promise<{ revisions: unknown[] }> {
    const runtime = this.runtimeForSession(sessionId);
    if (!runtime) throw new Error("session is not remote");
    return this.request(runtime, "session/revision/list", {
      sessionId,
      rootUserId,
    });
  }

  async activateRevision(input: {
    sessionId: string;
    rootUserId: string;
    revisionIndex: number;
    prefix?: unknown[];
  }): Promise<{ messages: unknown[] }> {
    const runtime = this.runtimeForSession(input.sessionId);
    if (!runtime) throw new Error("session is not remote");
    return this.request(runtime, "session/revision/activate", {
      sessionId: input.sessionId,
      rootUserId: input.rootUserId,
      revisionIndex: input.revisionIndex,
      prefix: input.prefix ?? [],
    });
  }

  async prompt(
    sessionId: string,
    content: string,
    attachments?: AgentPromptAttachment[],
    regenerate?: {
      truncateFromMessageId?: string;
      truncateBefore?: number;
      messageId?: string;
    },
  ): Promise<{ accepted: boolean; turnId: string }> {
    const runtime = this.runtimeForSession(sessionId);
    if (!runtime) throw new Error("session is not remote");
    const result = await this.request<{ accepted: boolean; turn: { id: string } }>(runtime, "turn/start", {
      sessionId,
      input: {
        text: content,
        ...(attachments?.length ? { attachments } : {}),
        ...(regenerate?.truncateFromMessageId ? { truncateFromMessageId: regenerate.truncateFromMessageId } : {}),
        ...(regenerate?.truncateBefore !== undefined ? { truncateBefore: regenerate.truncateBefore } : {}),
        ...(regenerate?.messageId ? { messageId: regenerate.messageId } : {}),
      },
      context: {
        requestId: `desktop-${sessionId}-${Date.now().toString(36)}`,
        idempotencyKey: `desktop-${sessionId}-${Date.now().toString(36)}`,
      },
    });
    return { accepted: result.accepted, turnId: result.turn.id };
  }

  async stopSession(sessionId: string, interrupt: boolean): Promise<{ requested?: boolean }> {
    const runtime = this.runtimeForSession(sessionId);
    if (!runtime) throw new Error("session is not remote");
    const turnId = runtime.activeTurns.get(sessionId) ?? (await this.snapshot(runtime, sessionId)).activeTurn?.id;
    if (!turnId) return { requested: false };
    await this.request(runtime, interrupt ? "turn/interrupt" : "turn/stop", {
      turnId,
      context: { requestId: `stop-${turnId}`, idempotencyKey: `stop-${turnId}` },
    });
    return { requested: true };
  }

  async getStatus(sessionId: string): Promise<AgentStatus> {
    const runtime = this.runtimeForSession(sessionId);
    if (!runtime) throw new Error("session is not remote");
    return activeTurnStatus(await this.snapshot(runtime, sessionId), runtime);
  }

  async queuePush(sessionId: string, content: string, attachments?: AgentPromptAttachment[]): Promise<QueuedTurnSummary> {
    const runtime = this.runtimeForSession(sessionId);
    if (!runtime) throw new Error("session is not remote");
    const result = await this.request<{ turn: { id: string; queuePosition?: number } }>(runtime, "turn/start", {
      sessionId,
      admission: "queue",
      input: { text: content, ...(attachments?.length ? { attachments } : {}) },
      context: { requestId: `queue-${sessionId}-${Date.now().toString(36)}` },
    });
    return {
      id: result.turn.id,
      sessionId,
      content,
      ...(attachments?.length ? { attachments } : {}),
      position: result.turn.queuePosition ?? 1,
      createdAt: new Date().toISOString(),
    };
  }

  async queueList(sessionId: string): Promise<QueuedTurnSummary[]> {
    const runtime = this.runtimeForSession(sessionId);
    if (!runtime) throw new Error("session is not remote");
    const snapshot = await this.snapshot(runtime, sessionId);
    return snapshot.queuedTurns.map((turn) => ({
      id: turn.id,
      sessionId,
      content: "",
      position: turn.queuePosition ?? 1,
      createdAt: turn.startedAt ?? new Date().toISOString(),
    }));
  }

  async queueRemove(turnId: string): Promise<void> {
    const runtime = this.runtimeForTurn(turnId);
    await this.request(runtime, "turn/cancel", { turnId, context: { requestId: `cancel-${turnId}`, idempotencyKey: `cancel-${turnId}` } });
  }

  async queuePrioritize(turnId: string): Promise<void> {
    const runtime = this.runtimeForTurn(turnId);
    await this.request(runtime, "turn/prioritize", { turnId, context: { requestId: `send-now-${turnId}`, idempotencyKey: `send-now-${turnId}` } });
  }

  async openTerminal(input: {
    sessionId: string;
    columns?: number;
    rows?: number;
  }): Promise<RemoteTerminalSnapshot> {
    const runtime = this.runtimeForSession(input.sessionId);
    if (!runtime) throw new Error("session is not remote");
    const result = await this.request<RemoteTerminalSnapshot>(runtime, "terminal/open", {
      sessionId: input.sessionId,
      ...(input.columns !== undefined ? { columns: input.columns } : {}),
      ...(input.rows !== undefined ? { rows: input.rows } : {}),
    });
    runtime.terminals.set(result.terminalId, input.sessionId);
    return result;
  }

  async writeTerminal(input: {
    sessionId: string;
    terminalId: string;
    text: string;
  }): Promise<void> {
    const runtime = this.runtimeForSession(input.sessionId);
    if (!runtime) throw new Error("session is not remote");
    await this.request(runtime, "terminal/input", input);
  }

  async resizeTerminal(input: {
    sessionId: string;
    terminalId: string;
    columns: number;
    rows: number;
  }): Promise<void> {
    const runtime = this.runtimeForSession(input.sessionId);
    if (!runtime) throw new Error("session is not remote");
    await this.request(runtime, "terminal/resize", input);
  }

  async closeTerminal(input: {
    sessionId: string;
    terminalId: string;
  }): Promise<void> {
    const runtime = this.runtimeForSession(input.sessionId);
    if (!runtime) throw new Error("session is not remote");
    await this.request(runtime, "terminal/close", input);
    runtime.terminals.delete(input.terminalId);
  }

  async resolvePermission(sessionId: string, requestId: string, decision: string): Promise<void> {
    const runtime = this.runtimeForSession(sessionId);
    if (!runtime) throw new Error("session is not remote");
    await this.request(runtime, "approval/respond", {
      approvalId: requestId,
      decision,
      context: { requestId: `approval-${requestId}`, idempotencyKey: `approval-${requestId}-${decision}` },
    });
    this.events.onAudit("remote.permission.decision", {
      connectionId: runtime.connection.id,
      sessionId,
      approvalId: requestId,
      decision,
    });
  }

  async resolveAsk(sessionId: string, resolution: AskToolResolution): Promise<void> {
    const runtime = this.runtimeForSession(sessionId);
    if (!runtime) throw new Error("session is not remote");
    await this.request(runtime, "input/respond", {
      inputId: resolution.requestId,
      answers: resolution.answers,
      context: { requestId: `input-${resolution.requestId}`, idempotencyKey: `input-${resolution.requestId}` },
    });
  }

  async pendingPlans(sessionId?: string): Promise<PlanProposal[]> {
    const result: PlanProposal[] = [];
    for (const runtime of this.connectedRuntimes()) {
      const sessions = sessionId ? [sessionId] : [...runtime.sessionSubscriptions.keys()];
      for (const candidate of sessions) {
        const snapshot = await this.snapshot(runtime, candidate);
        for (const approval of snapshot.pendingApprovals) {
          if (approval.kind === "tool") continue;
          result.push({
            id: approval.id,
            sessionId: candidate,
            turnId: approval.turnId,
            toolCallId: `${approval.id}:contract`,
            kind: approval.kind,
            title: approval.title ?? approval.summary,
            markdown: "",
            question: approval.question ?? "",
            ...(approval.artifact ? { artifact: approval.artifact } : {}),
            version: 1,
            status: "pending",
            createdAt: approval.expiresAt,
            updatedAt: approval.expiresAt,
            expiresAt: approval.expiresAt,
            plan: "",
          });
        }
      }
    }
    return result;
  }

  async resolvePlan(sessionId: string, proposalId: string, action: "approve" | "reject", permissionMode?: string): Promise<void> {
    const runtime = this.runtimeForSession(sessionId);
    if (!runtime) throw new Error("session is not remote");
    await this.request(runtime, "approval/respond", {
      approvalId: proposalId,
      decision: action,
      ...(action === "approve" && permissionMode ? { permissionMode } : {}),
      context: { requestId: `plan-${proposalId}`, idempotencyKey: `plan-${proposalId}-${action}` },
    });
    this.events.onAudit("remote.contract.decision", {
      connectionId: runtime.connection.id,
      sessionId,
      proposalId,
      action,
    });
  }

  async listWorkspace(sessionId: string | null, path?: string): Promise<FsEntry[]> {
    const runtime = this.workspaceRuntime(sessionId);
    const result = await this.request<{ entries: FsEntry[] }>(runtime, "workspace/list", {
      ...(sessionId ? { sessionId } : { sessionId: await this.activeProjectSession(runtime) }),
      ...(path ? { path } : {}),
    });
    return result.entries;
  }

  async readWorkspace(sessionId: string | null, path: string): Promise<FsReadResult> {
    const runtime = this.workspaceRuntime(sessionId);
    return this.request<FsReadResult>(runtime, "workspace/read", {
      sessionId: sessionId ?? await this.activeProjectSession(runtime),
      path,
    });
  }

  async workspaceDiff(sessionId: string | null): Promise<WorkspaceDiff> {
    const runtime = this.workspaceRuntime(sessionId);
    return this.request<WorkspaceDiff>(runtime, "workspace/diff", {
      sessionId: sessionId ?? await this.activeProjectSession(runtime),
    });
  }

  async indexWorkspace(sessionId: string | null): Promise<{ entries: Array<{ name: string; kind: "dir" | "file" }>; truncated: boolean }> {
    const runtime = this.workspaceRuntime(sessionId);
    const rootSession = sessionId ?? await this.activeProjectSession(runtime);
    const entries: Array<{ name: string; kind: "dir" | "file" }> = [];
    const queue: string[] = [""];
    const ignored = new Set([".git", "node_modules", ".venv", "venv", "dist", "build", "out", "target"]);
    let truncated = false;
    while (queue.length) {
      const directory = queue.shift()!;
      const result = await this.request<{ entries: FsEntry[] }>(runtime, "workspace/list", {
        sessionId: rootSession,
        ...(directory ? { path: directory } : {}),
      });
      for (const entry of result.entries) {
        if (ignored.has(entry.name)) continue;
        const relative = directory ? `${directory}/${entry.name}` : entry.name;
        if (entries.length >= 8_000) {
          truncated = true;
          break;
        }
        entries.push({ name: relative, kind: entry.kind });
        if (entry.kind === "dir") queue.push(relative);
      }
      if (truncated) break;
    }
    return { entries, truncated };
  }

  diagnostics(connectionId: string): RemoteDiagnostics {
    const view = this.viewFor(connectionId);
    return {
      desktopVersion: APP_VERSION,
      racpVersion: RACP_PROTOCOL_VERSION,
      localPlatform: process.platform,
      localArch: process.arch,
      sshExecutable: "configured",
      sshAlias: view.sshConfigAlias ?? view.hostname ?? "",
      ...(view.host?.platform ? { remotePlatform: view.host.platform } : {}),
      ...(view.host?.arch ? { remoteArch: view.host.arch } : {}),
      ...(view.host?.hostVersion ? { remoteHostVersion: view.host.hostVersion } : {}),
      connectionStage: view.state,
      ...(view.lastError ? { lastErrorCode: view.lastError.code } : {}),
      ...(view.lastExitCode !== undefined ? { lastExitCode: view.lastExitCode } : {}),
      portForwardState: view.state === "connected" ? "active" : view.lastError?.code === ErrorCodes.SSH_PORT_FORWARD_FAILED ? "failed" : "inactive",
      handshakeState: view.state === "connected" ? "initialized" : view.lastError?.code === ErrorCodes.REMOTE_HANDSHAKE_FAILED ? "failed" : "inactive",
      ...(this.activeProjectPathForConnection(connectionId) ? { remoteProjectPath: "configured" } : {}),
      sanitized: true,
    };
  }

  async importProvider(connectionId: string, providerId: string): Promise<{ imported: number }> {
    const connection = this.requireConnection(connectionId);
    const host = this.getHost();
    if (!host) throw new Error("local host unavailable");
    const provider = (await host.call<{ provider?: Record<string, unknown> }>("providers.get", { id: providerId })).provider;
    if (!provider) throw Object.assign(new Error("local provider not found"), { errorCode: ErrorCodes.NOT_FOUND });
    const secret = await host.call<{ value?: string }>("providers.getSecret", { id: providerId }).catch(() => ({ value: "" }));
    const input = { ...provider, ...(secret.value ? { secretValue: secret.value } : {}) };
    const encoded = Buffer.from(JSON.stringify(input), "utf8").toString("base64");
    const script = [
      `NODE="$HOME/.pi-desktop/host/current/node"`,
      `HOST="$HOME/.pi-desktop/host/current/pi-host.js"`,
      `RUNTIME="$HOME/.pi-desktop/host/runtime"`,
      `if [ ! -x "$NODE" ] || [ ! -f "$HOST" ]; then echo "REMOTE_HOST_UNAVAILABLE: pi-host is not installed" >&2; exit 1; fi`,
      `printf '%s' '${encoded}' | "$NODE" "$HOST" --provider-import --runtime-dir "$RUNTIME"`,
      "",
    ].join("\n");
    const result = await runSshScript(connection, script, {});
    if (result.code !== 0) throw classifySsh(result);
    this.events.onAudit("remote.provider.imported", { connectionId, providerId });
    try {
      return JSON.parse(result.stdout.trim()) as { imported: number };
    } catch {
      return { imported: 1 };
    }
  }

  async deleteProvider(connectionId: string, providerId: string): Promise<{ deleted: boolean }> {
    const connection = this.requireConnection(connectionId);
    if (!/^[A-Za-z0-9_.-]+$/.test(providerId)) {
      throw Object.assign(new Error("invalid provider id"), { errorCode: ErrorCodes.INVALID_ARGUMENT });
    }
    const script = [
      `NODE="$HOME/.pi-desktop/host/current/node"`,
      `HOST="$HOME/.pi-desktop/host/current/pi-host.js"`,
      `RUNTIME="$HOME/.pi-desktop/host/runtime"`,
      `if [ ! -x "$NODE" ] || [ ! -f "$HOST" ]; then echo "REMOTE_HOST_UNAVAILABLE: pi-host is not installed" >&2; exit 1; fi`,
      `printf '%s' '${providerId}' | "$NODE" "$HOST" --provider-delete --runtime-dir "$RUNTIME"`,
      "",
    ].join("\n");
    const result = await runSshScript(connection, script, {});
    if (result.code !== 0) throw classifySsh(result);
    this.events.onAudit("remote.provider.deleted", { connectionId, providerId });
    return { deleted: true };
  }

  remoteProjectContext(projectPath: string | null | undefined): {
    connectionId: string;
    connectionKey: string;
    remotePath: string;
  } | null {
    if (!projectPath || !isRemoteProjectPath(projectPath)) return null;
    const parsed = parseRemoteProjectUri(projectPath);
    const connection = parsed ? this.connectionForKey(parsed.connectionKey) : undefined;
    if (!connection || !parsed) return null;
    return {
      connectionId: connection.id,
      connectionKey: parsed.connectionKey,
      remotePath: parsed.remotePath,
    };
  }

  async listMcp(query: {
    level: "global" | "project";
    projectPath?: string;
  }): Promise<{ servers: McpServerRecord[]; statuses: McpServerStatus[] }> {
    const target = this.remoteProjectContext(query.projectPath);
    if (!target) throw Object.assign(new Error("a remote project is required"), { errorCode: ErrorCodes.UNSUPPORTED });
    const runtime = await this.requireConnected(target.connectionId);
    return this.request(runtime, "mcp/list", {
      level: query.level,
      ...(query.level === "project" || target.remotePath ? { projectPath: target.remotePath } : {}),
    });
  }

  async upsertMcp(server: McpServerInput, projectPath?: string): Promise<{ server: McpServerRecord }> {
    const target = this.remoteProjectContext(projectPath);
    if (!target) throw Object.assign(new Error("a remote project is required"), { errorCode: ErrorCodes.UNSUPPORTED });
    const runtime = await this.requireConnected(target.connectionId);
    const result = await this.request<{ server: McpServerRecord }>(runtime, "mcp/upsert", {
      server: {
        ...server,
        ...(server.projectPath ? { projectPath: target.remotePath } : {}),
      },
      ...(server.level === "project" || projectPath ? { projectPath: target.remotePath } : {}),
    });
    this.events.onAudit("remote.mcp.upserted", { connectionId: target.connectionId, serverId: server.id });
    return result;
  }

  async removeMcp(
    id: string,
    query: { level: "global" | "project"; projectPath?: string },
  ): Promise<{ ok?: boolean }> {
    const target = this.remoteProjectContext(query.projectPath);
    if (!target) throw Object.assign(new Error("a remote project is required"), { errorCode: ErrorCodes.UNSUPPORTED });
    const runtime = await this.requireConnected(target.connectionId);
    const result = await this.request<{ ok?: boolean }>(runtime, "mcp/remove", {
      id,
      level: query.level,
      ...(query.level === "project" || target.remotePath ? { projectPath: target.remotePath } : {}),
    });
    this.events.onAudit("remote.mcp.removed", { connectionId: target.connectionId, serverId: id });
    return result;
  }

  async setMcpEnabled(
    id: string,
    enabled: boolean,
    query: { level: "global" | "project"; projectPath?: string },
  ): Promise<{ server: McpServerRecord }> {
    const target = this.remoteProjectContext(query.projectPath);
    if (!target) throw Object.assign(new Error("a remote project is required"), { errorCode: ErrorCodes.UNSUPPORTED });
    const runtime = await this.requireConnected(target.connectionId);
    return this.request(runtime, "mcp/setEnabled", {
      id,
      enabled,
      level: query.level,
      ...(query.level === "project" || target.remotePath ? { projectPath: target.remotePath } : {}),
    });
  }

  async setMcpScope(
    id: string,
    scope: Record<string, unknown>,
    query: { level: "global" | "project"; projectPath?: string },
  ): Promise<{ server: McpServerRecord }> {
    const target = this.remoteProjectContext(query.projectPath);
    if (!target) throw Object.assign(new Error("a remote project is required"), { errorCode: ErrorCodes.UNSUPPORTED });
    const runtime = await this.requireConnected(target.connectionId);
    return this.request(runtime, "mcp/setScope", {
      id,
      scope,
      ...(target.remotePath ? { projectPath: target.remotePath } : {}),
    });
  }

  async testMcp(
    id: string,
    query: { level: "global" | "project"; projectPath?: string },
  ): Promise<{ status: McpServerStatus }> {
    const target = this.remoteProjectContext(query.projectPath);
    if (!target) throw Object.assign(new Error("a remote project is required"), { errorCode: ErrorCodes.UNSUPPORTED });
    const runtime = await this.requireConnected(target.connectionId);
    return this.request(runtime, "mcp/test", {
      id,
      level: query.level,
      ...(query.level === "project" || target.remotePath ? { projectPath: target.remotePath } : {}),
    });
  }

  async listSkills(query: {
    level: "global" | "project";
    projectPath?: string;
  }): Promise<{ skills: UserSkillRecord[] }> {
    const target = this.remoteProjectContext(query.projectPath);
    if (!target) throw Object.assign(new Error("a remote project is required"), { errorCode: ErrorCodes.UNSUPPORTED });
    const runtime = await this.requireConnected(target.connectionId);
    return this.request(runtime, "skills/list", {
      level: query.level,
      projectPath: target.remotePath,
    });
  }

  async createSkill(
    skill: UserSkillInput,
    projectPath?: string,
  ): Promise<{ skill: UserSkillRecord }> {
    const target = this.remoteProjectContext(projectPath);
    if (!target) throw Object.assign(new Error("a remote project is required"), { errorCode: ErrorCodes.UNSUPPORTED });
    const runtime = await this.requireConnected(target.connectionId);
    const result = await this.request<{ skill: UserSkillRecord }>(runtime, "skills/create", {
      skill: {
        ...skill,
        ...(skill.projectPath ? { projectPath: target.remotePath } : {}),
      },
    });
    this.events.onAudit("remote.skill.created", { connectionId: target.connectionId, skillId: skill.id ?? "" });
    return result;
  }

  async updateSkill(
    id: string,
    skill: UserSkillInput,
    projectPath?: string,
  ): Promise<{ skill: UserSkillRecord }> {
    const target = this.remoteProjectContext(projectPath);
    if (!target) throw Object.assign(new Error("a remote project is required"), { errorCode: ErrorCodes.UNSUPPORTED });
    const runtime = await this.requireConnected(target.connectionId);
    return this.request(runtime, "skills/update", {
      id,
      skill: {
        ...skill,
        ...(skill.projectPath ? { projectPath: target.remotePath } : {}),
      },
    });
  }

  async readSkill(query: {
    id: string;
    level?: "global" | "project";
    projectPath?: string;
  }): Promise<{ skill: UserSkillRecord | null; body: string | null }> {
    const target = this.remoteProjectContext(query.projectPath);
    if (!target) throw Object.assign(new Error("a remote project is required"), { errorCode: ErrorCodes.UNSUPPORTED });
    const runtime = await this.requireConnected(target.connectionId);
    return this.request(runtime, "skills/read", {
      id: query.id,
      ...(query.level ? { level: query.level } : {}),
      ...(query.level === "project" || query.projectPath ? { projectPath: target.remotePath } : {}),
    });
  }

  async removeSkill(query: {
    id: string;
    level: "global" | "project";
    projectPath?: string;
  }): Promise<{ ok?: boolean }> {
    const target = this.remoteProjectContext(query.projectPath);
    if (!target) throw Object.assign(new Error("a remote project is required"), { errorCode: ErrorCodes.UNSUPPORTED });
    const runtime = await this.requireConnected(target.connectionId);
    const result = await this.request<{ ok?: boolean }>(runtime, "skills/remove", {
      id: query.id,
      level: query.level,
      projectPath: target.remotePath,
    });
    this.events.onAudit("remote.skill.removed", { connectionId: target.connectionId, skillId: query.id });
    return result;
  }

  async setSkillEnabled(
    id: string,
    enabled: boolean,
    query: { level: "global" | "project"; projectPath?: string },
  ): Promise<{ skill: UserSkillRecord }> {
    const target = this.remoteProjectContext(query.projectPath);
    if (!target) throw Object.assign(new Error("a remote project is required"), { errorCode: ErrorCodes.UNSUPPORTED });
    const runtime = await this.requireConnected(target.connectionId);
    return this.request(runtime, "skills/setEnabled", {
      id,
      enabled,
      level: query.level,
      projectPath: target.remotePath,
    });
  }

  async setSkillScope(
    id: string,
    scope: Record<string, unknown>,
    projectPath?: string,
  ): Promise<{ skill: UserSkillRecord }> {
    const target = this.remoteProjectContext(projectPath);
    if (!target) throw Object.assign(new Error("a remote project is required"), { errorCode: ErrorCodes.UNSUPPORTED });
    const runtime = await this.requireConnected(target.connectionId);
    return this.request(runtime, "skills/setScope", {
      id,
      scope,
      ...(target.remotePath ? { projectPath: target.remotePath } : {}),
    });
  }

  private async connectInternal(runtime: RemoteRuntime): Promise<void> {
    runtime.explicitDisconnect = false;
    const id = runtime.connection.id;
    this.setState(id, "resolving");
    const config = await effectiveSshConfig(runtime.connection);
    if (!await knownHostAccepted(config)) {
      const scanned = await scanHostKeys(config);
      const accepted = await this.confirmFingerprint({
        connection: runtime.connection,
        fingerprints: scanned.fingerprints,
      });
      if (!accepted) {
        this.events.onAudit("ssh.host_key.canceled", { connectionId: id });
        throw Object.assign(new Error("remote host key was not accepted"), { errorCode: ErrorCodes.SSH_HOST_KEY_FAILED });
      }
      await acceptHostKeys(config, scanned.keys);
      this.events.onAudit("ssh.host_key.accepted", {
        connectionId: id,
        fingerprints: scanned.fingerprints,
      });
    }

    this.setState(id, "connecting");
    const probe = await sshProbe(runtime.connection);
    if (probe.os !== "Linux") {
      throw Object.assign(new Error(`remote OS ${probe.os || "unknown"} is unsupported; Linux is required`), {
        errorCode: ErrorCodes.REMOTE_OS_UNSUPPORTED,
      });
    }
    const arch = remoteArch(probe.arch);
    this.setState(id, "authenticating");

    const hostId = this.hostIdFor(id);
    let host = this.store.getHost(hostId);
    let token = await this.readToken(hostId);
    let metadata = await readRemoteRuntimeMetadata(runtime.connection);
    if (!metadata || metadata.version !== APP_VERSION || !token) {
      this.setState(id, "bootstrapping");
      const checksum = await releaseChecksum(APP_VERSION, arch);
      const bootstrap = await runSshScript(runtime.connection, readFileSync(bootstrapScriptPath(), "utf8"), {
        PI_HOST_VERSION: APP_VERSION,
        PI_HOST_ARCH: arch,
        PI_HOST_CHECKSUM: checksum,
        ...(token ? {} : { PI_HOST_FORCE_RESTART: "1" }),
      });
      this.events.onAudit(token ? "remote.host.upgraded" : "remote.host.installed", {
        connectionId: id,
        version: APP_VERSION,
        arch,
      });
      const parsed = parseBootstrapOutput(bootstrap.stdout);
      const ready = parsed.ready;
      const port = Number(ready?.port ?? metadata?.port ?? 0);
      if (!Number.isInteger(port) || port <= 0) {
        throw Object.assign(new Error(bootstrap.stdout.trim() || "pi-host bootstrap returned no endpoint"), {
          errorCode: ErrorCodes.REMOTE_HOST_START_FAILED,
        });
      }
      const pairing = ready?.pairing;
      if (!token && pairing && typeof pairing === "object") {
        token = String((pairing as { token?: unknown }).token ?? "");
      }
      metadata = {
        pid: Number(ready?.pid ?? metadata?.pid ?? 0),
        port,
        version: APP_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        storageSchemaVersion: SCHEMA_VERSION,
        startedAt: new Date().toISOString(),
      };
    }
    if (!token) {
      throw Object.assign(new Error("pi-host did not return a pairing token"), { errorCode: ErrorCodes.REMOTE_PAIRING_FAILED });
    }

    host = {
      id: hostId,
      connectionId: id,
      platform: "linux",
      arch,
      hostVersion: String(metadata.version ?? APP_VERSION),
      protocolVersion: Number(metadata.protocolVersion ?? PROTOCOL_VERSION),
      storageSchemaVersion: Number(metadata.storageSchemaVersion ?? SCHEMA_VERSION),
      racpVersion: RACP_PROTOCOL_VERSION,
      lastConnectedAt: new Date().toISOString(),
    };
    this.store.putHost(host);
    runtime.host = host;

    this.setState(id, "forwarding");
    const localPort = await freeLoopbackPort();
    const tunnel = await startSshTunnel(runtime.connection, Number(metadata.port), localPort);
    runtime.tunnel = tunnel;
    void tunnel.exit.then((result) => {
      if (runtime.tunnel !== tunnel || runtime.explicitDisconnect) return;
      const error = classifySsh(result);
      this.failure(id, error);
      this.scheduleReconnect(id);
    });

    this.setState(id, "handshaking");
    const client = new RacpWsClient({
      url: `ws://127.0.0.1:${localPort}/v1/racp/ws`,
      token,
      clientInfo: { name: "pi-desktop", version: APP_VERSION },
    });
    runtime.client = client;
    client.onEvent((event) => this.handleRacpEvent(runtime, event));
    client.onClose(() => {
      if (runtime.client !== client || runtime.explicitDisconnect) return;
      this.disconnectTerminals(runtime);
      this.failure(id, Object.assign(new Error("RACP connection closed"), { code: ErrorCodes.REMOTE_HOST_UNAVAILABLE }));
      this.scheduleReconnect(id);
    });
    let initialized: RacpInitializeResult;
    try {
      initialized = await client.connect();
    } catch (error) {
      await this.closeTransport(runtime);
      throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), {
        errorCode: ErrorCodes.REMOTE_HANDSHAKE_FAILED,
      });
    }
    this.verifyVersions(initialized);
    if (initialized.deviceToken) {
      token = initialized.deviceToken;
      await this.writeToken(hostId, token);
      this.events.onAudit("remote.pairing.created", { connectionId: id, hostId });
    }
    if (!initialized.deviceToken) await this.writeToken(hostId, token);

    const hostSubscription = await client.request<{ subscriptionId: string }>("events/subscribe", { scope: "host" });
    runtime.hostSubscription = hostSubscription.subscriptionId;
    await this.listSessions();
    this.events.onSessionsChanged();
    this.events.onAudit("connection.opened", {
      connectionId: id,
      hostId,
      protocolVersion: PROTOCOL_VERSION,
      storageSchemaVersion: SCHEMA_VERSION,
    });
    runtime.reconnectAttempt = 0;
    runtime.state = "connected";
    runtime.lastError = undefined;
    this.events.onConnectionsChanged();
  }

  private verifyVersions(initialized: RacpInitializeResult): void {
    if (!protocolVersionsCompatible(initialized.protocolVersion, RACP_PROTOCOL_VERSION) ||
        initialized.server.hostProtocolVersion !== PROTOCOL_VERSION ||
        initialized.server.storageSchemaVersion !== SCHEMA_VERSION) {
      throw Object.assign(new Error(
        `remote Host version mismatch: desktop ${APP_VERSION}/${PROTOCOL_VERSION}/${SCHEMA_VERSION}, remote ${initialized.server.version}/${initialized.server.hostProtocolVersion ?? "?"}/${initialized.server.storageSchemaVersion ?? "?"}`,
      ), { errorCode: ErrorCodes.REMOTE_HOST_VERSION_INCOMPATIBLE });
    }
  }

  private handleRacpEvent(runtime: RemoteRuntime, racpEvent: RacpClientEvent): void {
    if (!("eventId" in racpEvent)) return;
    const event = racpEvent as RacpEventEnvelope;
    if (event.kind === "terminal.output" || event.kind === "terminal.changed") {
      const terminalEvent = event.payload as RemoteTerminalEvent;
      this.events.onTerminalEvent(terminalEvent);
      if (terminalEvent.kind === "changed" && terminalEvent.status === "exit") {
        runtime.terminals.delete(terminalEvent.terminalId);
      }
      return;
    }
    if (event.sessionId && typeof event.sequence === "number") {
      runtime.sessionCursors.set(event.sessionId, { epoch: event.epoch, sequence: event.sequence });
      const subscription = runtime.sessionSubscriptions.get(event.sessionId);
      if (subscription) {
        void runtime.client?.request("events/ack", { subscriptionId: subscription, sequence: event.sequence }).catch(() => undefined);
      }
    }
    if (event.kind === "turn.queued" && event.sessionId && event.turnId) {
      this.turnRuntimes.set(event.turnId, runtime.connection.id);
    }
    if (event.kind === "turn.started" && event.sessionId && event.turnId) {
      runtime.activeTurns.set(event.sessionId, event.turnId);
      this.turnRuntimes.set(event.turnId, runtime.connection.id);
    }
    if ((event.kind === "turn.completed" || event.kind === "turn.interrupted" || event.kind === "turn.failed" || event.kind === "turn.canceled") && event.sessionId) {
      runtime.activeTurns.delete(event.sessionId);
      if (event.turnId) this.turnRuntimes.delete(event.turnId);
    }
    if (event.kind === "approval.requested") {
      const approval = event.payload as { id?: string };
      if (approval.id && event.sessionId) this.approvalRuntimes.set(approval.id, event.sessionId);
      this.events.onAudit("remote.permission.requested", {
        connectionId: runtime.connection.id,
        sessionId: event.sessionId,
        approvalId: approval.id,
      });
    }
    if (event.kind === "approval.resolved") {
      const approval = event.payload as { approvalId?: string };
      if (approval.approvalId) this.approvalRuntimes.delete(approval.approvalId);
    }
    if (event.kind === "turn.queued" || event.kind === "turn.canceled") {
      const turn = (event.payload as { turn?: { id: string; queuePosition?: number } }).turn;
      if (event.sessionId && turn) {
        this.events.onQueueChanged({
          sessionId: event.sessionId,
          entries: [{
            id: turn.id,
            sessionId: event.sessionId,
            content: "",
            position: turn.queuePosition ?? 1,
            createdAt: event.occurredAt,
          }],
        });
      }
    }
    if (["session.created", "session.changed", "session.archived"].includes(event.kind)) {
      this.events.onSessionsChanged();
    }
    const local = this.localAgentEvent(event);
    if (local) this.events.onAgentEvent(local);
  }

  private localAgentEvent(event: RacpEventEnvelope): AgentEventEnvelope | null {
    const payload = event.payload as { event?: AgentEventEnvelope["event"] };
    if (payload.event) {
      return {
        sessionId: event.sessionId ?? "",
        ...(event.turnId ? { turnId: event.turnId } : {}),
        ts: Date.parse(event.occurredAt) || Date.now(),
        event: payload.event,
        ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
        ...(event.agentName ? { agentName: event.agentName } : {}),
      };
    }
    if (event.kind === "approval.requested") {
      const approval = event.payload as {
        id?: string; sessionId?: string; turnId?: string; toolCallId?: string; toolName?: string; risk?: "low" | "medium" | "high"; summary?: string;
      };
      if (!approval.id || !approval.sessionId) return null;
      const request: ToolPermissionRequest = {
        requestId: approval.id,
        sessionId: approval.sessionId,
        toolCallId: approval.toolCallId ?? `${approval.id}:tool`,
        toolName: approval.toolName ?? "Tool",
        argsPreview: {},
        risk: approval.risk ?? "medium",
        reason: approval.summary ?? "remote approval",
        ...(event.agentName ? { agentName: event.agentName } : {}),
        ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
      };
      return {
        sessionId: approval.sessionId,
        ...(approval.turnId ? { turnId: approval.turnId } : {}),
        ts: Date.parse(event.occurredAt) || Date.now(),
        event: { type: "tool_permission_request", request },
        ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
        ...(event.agentName ? { agentName: event.agentName } : {}),
      };
    }
    return null;
  }

  private scheduleReconnect(id: string): void {
    if (this.disposed) return;
    const runtime = this.runtimes.get(id);
    if (!runtime || runtime.explicitDisconnect || runtime.reconnectTimer) return;
    const delay = REMOTE_RECONNECT_DELAYS_MS[Math.min(runtime.reconnectAttempt, REMOTE_RECONNECT_DELAYS_MS.length - 1)] ?? 30_000;
    runtime.reconnectAttempt += 1;
    runtime.state = "reconnecting";
    this.events.onAudit("connection.reconnect_scheduled", {
      connectionId: id,
      attempt: runtime.reconnectAttempt,
      delay,
    });
    this.events.onConnectionsChanged();
    runtime.reconnectTimer = setTimeout(() => {
      runtime.reconnectTimer = undefined;
      void this.connect(id).catch(() => undefined);
    }, delay);
  }

  private async closeTransport(runtime: RemoteRuntime): Promise<void> {
    const client = runtime.client;
    const tunnel = runtime.tunnel;
    runtime.client = undefined;
    runtime.tunnel = undefined;
    runtime.hostSubscription = undefined;
    runtime.sessionSubscriptions.clear();
    this.disconnectTerminals(runtime);
    if (client) await client.disconnect().catch(() => undefined);
    if (tunnel) {
      disposeTunnel(tunnel);
      await Promise.race([tunnel.exit, new Promise((resolve) => setTimeout(resolve, 1_000).unref?.())]);
    }
  }

  private disconnectTerminals(runtime: RemoteRuntime): void {
    for (const [terminalId, sessionId] of runtime.terminals) {
      this.events.onTerminalEvent({
        kind: "changed",
        sessionId,
        terminalId,
        status: "exit",
      });
    }
    runtime.terminals.clear();
  }

  private failure(id: string, error: unknown): void {
    const runtime = this.runtimeFor(id);
    const previousState = runtime.state;
    runtime.lastError = publicError(error, previousState === "reconnecting" ? "connecting" : previousState);
    runtime.lastExitCode = exitCodeOf(error);
    runtime.state = "error";
    const lastError = runtime.lastError;
    if (!lastError) return;
    this.events.onAudit("connection.failed", {
      connectionId: id,
      code: lastError.code,
      stage: lastError.stage,
      exitCode: runtime.lastExitCode,
    });
    this.events.onConnectionsChanged();
  }

  private setState(id: string, state: RemoteConnectionState): void {
    const runtime = this.runtimeFor(id);
    runtime.state = state;
    this.events.onAudit("connection.stage", { connectionId: id, stage: state });
    this.events.onConnectionsChanged();
  }

  private viewFor(id: string): RemoteConnectionView {
    return this.listConnections().find((connection) => connection.id === id)!;
  }

  private hostIdFor(connectionId: string): string {
    return `host_${sha256(connectionId).slice(0, 24)}`;
  }

  private connectionKey(connection: RemoteConnection): string {
    const base = connection.sshConfigAlias ?? connection.hostname ?? connection.id;
    const duplicates = this.store.listConnections().filter((candidate) =>
      (candidate.sshConfigAlias ?? candidate.hostname ?? candidate.id) === base,
    );
    return duplicates.length > 1 ? `${base}-${connection.id.replace(/[^a-zA-Z0-9._-]+/g, "-")}` : base;
  }

  private connectionForKey(key: string): RemoteConnection | undefined {
    return this.store.listConnections().find((connection) => this.connectionKey(connection) === key);
  }

  private workspaceForProject(project: RemoteProjectRecord, isRepo = false): ProjectWorkspace {
    const connection = this.store.getConnection(project.connectionId);
    const key = connection ? this.connectionKey(connection) : project.connectionId;
    const path = remoteProjectUri({ connectionKey: key, remotePath: project.normalizedRemotePath });
    if (!path) throw new Error("could not construct remote project URI");
    return {
      path,
      name: project.name || basename(project.normalizedRemotePath),
    };
  }

  private activeProjectPathForConnection(connectionId: string): string | null {
    if (!this.activeProjectId) return null;
    const project = this.store.getProject(this.activeProjectId);
    return project?.connectionId === connectionId ? project.normalizedRemotePath : null;
  }

  private requireConnection(id: string): RemoteConnection {
    const connection = this.store.getConnection(id);
    if (!connection) throw Object.assign(new Error("remote connection not found"), { errorCode: ErrorCodes.REMOTE_PROJECT_NOT_FOUND });
    return connection;
  }

  private runtimeFor(id: string): RemoteRuntime {
    let runtime = this.runtimes.get(id);
    if (!runtime) {
      runtime = {
        connection: this.requireConnection(id),
        state: "disconnected",
        explicitDisconnect: false,
        reconnectAttempt: 0,
        sessionCursors: new Map(),
        sessionSubscriptions: new Map(),
        activeTurns: new Map(),
        sessionProjects: new Map(),
        terminals: new Map(),
      };
      this.runtimes.set(id, runtime);
    }
    return runtime;
  }

  private async requireConnected(id: string): Promise<RemoteRuntime> {
    const runtime = this.runtimeFor(id);
    if (!runtime.client) await this.connect(id);
    return runtime;
  }

  private requireRuntimeHost(runtime: RemoteRuntime): RemoteHostRuntime {
    const host = runtime.host ?? this.store.getHost(this.hostIdFor(runtime.connection.id));
    if (!host) throw Object.assign(new Error("remote Host is not registered"), { errorCode: ErrorCodes.REMOTE_HOST_UNAVAILABLE });
    return host;
  }

  private connectedRuntimes(): RemoteRuntime[] {
    return [...this.runtimes.values()].filter((runtime) => Boolean(runtime.client));
  }

  private runtimeForSession(sessionId: string): RemoteRuntime | undefined {
    const connectionId = this.sessionRuntimes.get(sessionId);
    return connectionId ? this.runtimes.get(connectionId) : undefined;
  }

  private runtimeForTurn(turnId: string): RemoteRuntime {
    for (const runtime of this.connectedRuntimes()) {
      if ([...runtime.activeTurns.values()].includes(turnId)) return runtime;
    }
    throw Object.assign(new Error("remote turn not found"), { errorCode: ErrorCodes.TURN_NOT_FOUND });
  }

  private runtimeForActiveProject(): RemoteRuntime {
    const project = this.activeProjectId ? this.store.getProject(this.activeProjectId) : undefined;
    if (!project) throw Object.assign(new Error("no remote project is active"), { errorCode: ErrorCodes.REMOTE_PROJECT_NOT_FOUND });
    const runtime = this.runtimes.get(project.connectionId);
    if (!runtime?.client) throw Object.assign(new Error("remote project is not connected"), { errorCode: ErrorCodes.REMOTE_HOST_UNAVAILABLE });
    return runtime;
  }

  private workspaceRuntime(sessionId: string | null): RemoteRuntime {
    if (sessionId) {
      const runtime = this.runtimeForSession(sessionId);
      if (!runtime) throw Object.assign(new Error("session is not remote"), { errorCode: ErrorCodes.NOT_FOUND });
      return runtime;
    }
    return this.runtimeForActiveProject();
  }

  private async activeProjectSession(runtime: RemoteRuntime): Promise<string> {
    const project = this.activeProjectId ? this.store.getProject(this.activeProjectId) : undefined;
    for (const [sessionId, connectionId] of this.sessionRuntimes) {
      if (connectionId !== runtime.connection.id) continue;
      if (!project || runtime.sessionProjects.get(sessionId) === project.normalizedRemotePath) return sessionId;
    }
    const sessions = await this.request<{ sessions: RacpSession[] }>(runtime, "session/list");
    const session = sessions.sessions[0];
    if (!session) throw Object.assign(new Error("remote project has no session"), { errorCode: ErrorCodes.REMOTE_PROJECT_NOT_FOUND });
    return session.id;
  }

  private async snapshot(runtime: RemoteRuntime, sessionId: string): Promise<RacpSessionSnapshot> {
    const attached = await this.request<{ snapshot: RacpSessionSnapshot }>(runtime, "session/attach", {
      sessionId,
      includeSnapshot: true,
      ...(this.cursor(runtime, sessionId) ? { after: this.cursor(runtime, sessionId) } : {}),
    });
    return attached.snapshot;
  }

  private cursor(runtime: RemoteRuntime, sessionId: string): { epoch: string; sequence: number } | undefined {
    return runtime.sessionCursors.get(sessionId);
  }

  private async subscribeSession(runtime: RemoteRuntime, sessionId: string): Promise<void> {
    if (runtime.sessionSubscriptions.has(sessionId)) return;
    const result = await this.request<{ subscriptionId: string }>(runtime, "events/subscribe", {
      scope: "session",
      sessionId,
      ...(this.cursor(runtime, sessionId) ? { after: this.cursor(runtime, sessionId) } : {}),
    });
    runtime.sessionSubscriptions.set(sessionId, result.subscriptionId);
    this.sessionRuntimes.set(sessionId, runtime.connection.id);
  }

  private projectPathFor(
    runtime: RemoteRuntime,
    session: RacpSession,
    remoteProjects: Map<string, string | undefined>,
  ): string {
    const remotePath = session.projectId ? remoteProjects.get(session.projectId) : undefined;
    if (remotePath) runtime.sessionProjects.set(session.id, remotePath);
    const path = runtime.sessionProjects.get(session.id) ?? remotePath;
    if (!path) return "";
    return remoteProjectUri({ connectionKey: this.connectionKey(runtime.connection), remotePath: path }) ?? "";
  }

  private sessionProjectPath(runtime: RemoteRuntime, sessionId: string): string {
    const path = runtime.sessionProjects.get(sessionId);
    return path ? remoteProjectUri({ connectionKey: this.connectionKey(runtime.connection), remotePath: path }) ?? "" : "";
  }

  private toSessionSummary(
    runtime: RemoteRuntime,
    session: RacpSession,
    projectPath: string,
    messageCount = 0,
  ): SessionSummary {
    return {
      id: session.id,
      title: session.title,
      ...(projectPath ? { projectPath } : {}),
      ...(session.projectId ? { projectId: session.projectId } : {}),
      hostId: this.hostIdFor(runtime.connection.id),
      mode: session.mode,
      thinkingLevel: thinkingLevel(session.thinkingLevel),
      ...(session.providerId ? { providerId: session.providerId } : {}),
      ...(session.modelId ? { modelId: session.modelId } : {}),
      messageCount: session.messageCount ?? messageCount,
      permissionMode: session.permissionMode,
      supportsReasoning: false,
      supportsVision: false,
      supportedThinkingLevels: ["off"],
      updatedAt: session.updatedAt,
      createdAt: session.createdAt,
    };
  }

  private async readToken(hostId: string): Promise<string | null> {
    const host = this.getHost();
    if (!host) return null;
    const result = await host.call<{ value?: string }>("secrets.getForRuntime", { secretRef: tokenRef(hostId) }).catch(() => ({ value: undefined }));
    return result.value ?? null;
  }

  private async writeToken(hostId: string, token: string): Promise<void> {
    const host = this.getHost();
    if (!host) throw new Error("local host unavailable");
    await host.call("secrets.set", { secretRef: tokenRef(hostId), value: token });
  }

  private async request<T>(runtime: RemoteRuntime, method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!runtime.client) throw Object.assign(new Error("remote Host is unavailable"), { errorCode: ErrorCodes.REMOTE_HOST_UNAVAILABLE });
    try {
      return await runtime.client.request<T>(method, params);
    } catch (error) {
      throw toIpcError(error);
    }
  }
}

function classifySsh(result: { code: number; stdout: string; stderr: string }): SshError {
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  const code =
    /permission denied|authentications that can continue/.test(text) ? "SSH_AUTH_FAILED" :
    /host key verification failed/.test(text) ? "SSH_HOST_KEY_FAILED" :
    /timed out/.test(text) ? "SSH_CONNECTION_TIMEOUT" :
    /could not resolve/.test(text) ? "SSH_RESOLVE_FAILED" :
    "SSH_CONNECTION_CLOSED";
  return new SshError(code, result.stderr.trim() || result.stdout.trim() || "SSH command failed", "connecting", result.code);
}

export type { RemoteConnectionInput, RemoteDiagnostics };
