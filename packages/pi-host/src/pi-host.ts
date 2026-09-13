import { basename, join } from "node:path";
import type {
  AgentEventEnvelope,
  AskToolResolution,
  ModelBinding,
  PlanProposal,
  PlanningStateEvent,
  FsReadResult,
  McpServerInput,
  McpServerRecord,
  McpServerStatus,
  RacpProjectSummary,
  RacpSession,
  RacpSessionMode,
  RacpSessionStatus,
  RemoteDirectoryResult,
  SessionSummary,
  UiMessage,
  UserSkillRecord,
  WorkspaceDiff,
} from "@pi-desktop/shared";
import {
  ErrorCodes,
  isGlobalPermissionMode,
  normalizeProposalKind,
  normalizeMode,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
} from "@pi-desktop/shared";
import {
  capabilitiesFromModelConfig,
  genericModelConfig,
  loadInstructionChain,
  loadSubagentDefinitions,
  modelConfigWithBinding,
  optionalProviderHeaders,
  visionFromModelConfig,
  type PluginToolDef,
  type PluginSkillDef,
} from "@pi-desktop/agent-runtime";
import {
  AgentHost,
  RacpError,
  type ApprovalPort,
  type PendingToolRequest,
  type Principal,
  type QueueStore,
  type QueuedTurnRecord,
  type RacpRemoteProfile,
  type RacpRelayTool,
  type RuntimePort,
  type SessionPort,
  type SessionSummary as AgentSessionSummary,
  type TurnStartRequest,
} from "@pi-desktop/agent-host";
import type { RpcProcess } from "./rpc-process.js";
import { RemoteMcpRuntime } from "./mcp.js";
import { RemoteTerminalManager } from "./terminal.js";
import {
  browseRemotePath,
  collectSessionDiff,
  listSessionWorkspace,
  readSessionWorkspace,
} from "./workspace.js";

type HostSession = SessionSummary & {
  messages?: UiMessage[];
  hasMoreBefore?: boolean;
};

type RuntimeProvider = {
  id: string;
  name: string;
  vendorKey?: string;
  baseUrl?: string;
  models?: ModelBinding[];
  defaultModelId?: string;
  authKind?: string;
  apiStyle?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
};

type ActiveTool = {
  toolName: string;
  args: unknown;
  createdAt: string;
  turnId: string;
  parentToolCallId?: string;
  agentName?: string;
};

const OWNER: Principal = { subject: "desktop", roles: ["owner"], pairedDevice: true };

function permissionMode(value: unknown): "ask" | "accept-edits" | "auto" {
  return value === "accept-edits" || value === "auto" ? value : "ask";
}

function mode(value: unknown): RacpSessionMode {
  const normalized = normalizeMode(value);
  return normalized === "plan" || normalized === "goal" ? normalized : "agent";
}

function toRacpStatus(sessionId: string, activeTurns: Map<string, string>): RacpSessionStatus {
  return activeTurns.has(sessionId) ? "running" : "idle";
}

/**
 * The headless desktop runtime. It owns no transport, Electron API, or SSH
 * detail; RACP and bootstrap are callers around this service.
 */
export class PiHostService {
  readonly agentHost: AgentHost;
  private readonly activeTurns = new Map<string, string>();
  private readonly activeTools = new Map<string, ActiveTool>();
  private readonly sessionProjects = new Map<string, string | null>();
  private readonly persistedMessages = new Set<string>();
  private readonly queueStore: QueueStore;
  private readonly terminals: RemoteTerminalManager;
  private readonly mcp = new RemoteMcpRuntime();

  constructor(
    private readonly host: RpcProcess,
    private readonly sidecar: RpcProcess,
    private readonly dataDir: string,
  ) {
    this.queueStore = this.createQueueStore();
    this.agentHost = new AgentHost({
      runtime: this.createRuntime(),
      sessions: this.createSessions(),
      approvals: this.createApprovals(),
      queueStore: this.queueStore,
      allowRemoteSessionGrants: true,
      onQueueChange: () => undefined,
    });
    this.terminals = new RemoteTerminalManager(
      (event) => this.agentHost.hub.publish({
        scope: "session",
        sessionId: event.sessionId,
        revision: 0,
        kind: "terminal.output",
        payload: event,
      }),
      (event) => this.agentHost.hub.publish({
        scope: "session",
        sessionId: event.sessionId,
        revision: 0,
        kind: "terminal.changed",
        payload: event,
      }),
    );
  }

  async start(): Promise<void> {
    await this.host.call("app.handshake", { protocolVersion: PROTOCOL_VERSION });
    await this.sidecar.call("sidecar.configure", {
      hostBinary: process.env.PI_DESKTOP_HOST_BIN,
      dataDir: this.dataDir,
    });
    await this.agentHost.start();
    await this.refreshMcpRecords();
  }

  dispose(): void {
    this.terminals.closeAll();
    this.mcp.disposeAll();
  }

  async executeSkill(input: {
    sessionId: string;
    args: unknown;
  }): Promise<{ ok: boolean; content: string; isError?: boolean }> {
    const id = String((input.args as { id?: unknown } | null)?.id ?? "").trim();
    if (!id) {
      return { ok: false, content: "Skill: `id` is required.", isError: true };
    }
    const session = await this.getSession(input.sessionId);
    const result = await this.host.call<{
      skill?: { name?: string } | null;
      body?: string | null;
    }>("skills.read", {
      id,
      ...(session.projectPath ? { projectPath: session.projectPath } : {}),
    });
    if (!result.skill || typeof result.body !== "string") {
      return { ok: false, content: `Skill "${id}" was not found.`, isError: true };
    }
    return {
      ok: true,
      content: `# Skill: ${result.skill.name ?? id} (${id})\n\n${result.body}`,
    };
  }

  remoteProfile(): RacpRemoteProfile {
    return {
      listProjects: async () => {
        const result = await this.host.call<{ projects?: Array<{ id?: number; path?: string; name?: string }> }>("projects.list");
        return (result.projects ?? []).map((project) => ({
          id: String(project.id ?? project.path ?? ""),
          label: project.name || basename(project.path ?? "project"),
          ...(project.path ? { path: project.path } : {}),
          archived: false,
        }));
      },
      listSessions: async () => {
        const [sessions, projects] = await Promise.all([
          this.host.call<{ sessions?: HostSession[] }>("session.list"),
          this.projectIndex(),
        ]);
        return (sessions.sessions ?? []).map((session) =>
          this.toRacpSession(session, projects),
        );
      },
      createSession: async (params) => {
        const projects = await this.projectIndex();
        const projectId = typeof params.projectId === "string" ? params.projectId : undefined;
        const projectPath = projects.get(projectId ?? "");
        const directProjectPath = typeof params.projectPath === "string" ? params.projectPath : undefined;
        const result = await this.host.call<{ session?: HostSession }>("session.create", {
          ...(typeof params.title === "string" ? { title: params.title } : {}),
          ...(params.mode ? { mode: params.mode } : {}),
          ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
          ...(params.providerId ? { providerId: params.providerId } : {}),
          ...(params.modelId ? { modelId: params.modelId } : {}),
          ...(params.thinkingLevel ? { thinkingLevel: params.thinkingLevel } : {}),
          ...(projectPath ?? directProjectPath ? { projectPath: projectPath ?? directProjectPath } : {}),
        });
        if (!result.session) throw new RacpError("INTERNAL", "host returned no session");
        this.sessionProjects.set(result.session.id, result.session.projectPath ?? null);
        const summary = this.toAgentSummary(result.session, projects, permissionMode((await this.settings()).defaultPermissionMode));
        this.agentHost.publishSessionChange("session.created", summary);
        return this.toRacpSession(result.session, projects);
      },
      configureSession: async (params) => {
        const sessionId = requiredString(params.sessionId, "sessionId");
        const before = await this.getSession(sessionId);
        const result = await this.host.call<{ session?: HostSession }>("session.configure", {
          id: sessionId,
          mode: typeof params.mode === "string" ? params.mode : mode(before.mode),
          ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
          ...(params.providerId ? { providerId: params.providerId } : {}),
          ...(params.modelId ? { modelId: params.modelId } : {}),
          ...(params.thinkingLevel ? { thinkingLevel: params.thinkingLevel } : {}),
        });
        if (!result.session) throw new RacpError("NOT_FOUND", `session ${sessionId} is unknown`);
        await this.publishChanged(result.session);
        return this.toRacpSession(result.session, await this.projectIndex());
      },
      forkSession: async (params) => {
        const result = await this.host.call<{ session?: HostSession }>("session.fork", {
          sessionId: requiredString(params.sessionId, "sessionId"),
          ...(typeof params.title === "string" ? { title: params.title } : {}),
          ...(typeof params.throughMessageId === "string" ? { throughMessageId: params.throughMessageId } : {}),
        });
        if (!result.session) throw new RacpError("NOT_FOUND", "source session is unknown");
        await this.publishChanged(result.session);
        return this.toRacpSession(result.session, await this.projectIndex());
      },
      renameSession: async (params) => {
        const sessionId = requiredString(params.sessionId, "sessionId");
        const title = requiredString(params.title, "title");
        await this.host.call("session.rename", { id: sessionId, title });
        const session = await this.getSession(sessionId);
        await this.publishChanged(session);
        return this.toRacpSession(session, await this.projectIndex());
      },
      deleteSession: async (params) => {
        const sessionId = requiredString(params.sessionId, "sessionId");
        await this.host.call("session.delete", { id: sessionId });
        this.sessionProjects.delete(sessionId);
        this.terminals.closeSession(sessionId);
      },
      compactSession: async (params) => {
        const sessionId = requiredString(params.sessionId, "sessionId");
        const session = await this.getSession(sessionId);
        const launch = await this.resolveLaunch(session);
        return this.sidecar.call("agent.compact", launch.sidecarParams);
      },
      browseWorkspace: async (params) => {
        const path = typeof params.path === "string" ? params.path : undefined;
        return browseRemotePath(path, process.env.HOME ?? "/root");
      },
      listWorkspace: async (params) => {
        const session = await this.getSession(requiredString(params.sessionId, "sessionId"));
        return { entries: await listSessionWorkspace(requiredRoot(session), stringOrUndefined(params.path)) };
      },
      readWorkspace: async (params) => {
        const session = await this.getSession(requiredString(params.sessionId, "sessionId"));
        return readSessionWorkspace(requiredRoot(session), requiredString(params.path, "path"));
      },
      diffWorkspace: async (params) => {
        const session = await this.getSession(requiredString(params.sessionId, "sessionId"));
        return collectSessionDiff(requiredRoot(session));
      },
      listMcp: async (params) => {
        const result = await this.host.call<{ servers?: McpServerRecord[] }>("mcp.list", params);
        const servers = result.servers ?? [];
        this.mcp.mergeRecords(servers);
        return {
          servers,
          statuses: servers.map((server) => this.mcp.statusFor(server.id)),
        };
      },
      upsertMcp: async (params) => {
        const result = await this.host.call<{ server: McpServerRecord }>("mcp.upsert", params);
        await this.refreshMcpRecords();
        return result;
      },
      removeMcp: async (params) => {
        const result = await this.host.call<{ ok?: boolean }>("mcp.remove", params);
        await this.refreshMcpRecords();
        return result;
      },
      setMcpEnabled: async (params) => {
        const result = await this.host.call<{ server: McpServerRecord }>("mcp.setEnabled", params);
        await this.refreshMcpRecords();
        return result;
      },
      setMcpScope: async (params) => {
        const result = await this.host.call<{ server: McpServerRecord }>("mcp.setScope", params);
        await this.refreshMcpRecords();
        return result;
      },
      testMcp: async (params) => {
        const listed = await this.host.call<{ servers?: McpServerRecord[] }>("mcp.list", params);
        const server = (listed.servers ?? []).find((entry) => entry.id === params.id);
        if (!server) throw new RacpError("NOT_FOUND", "remote MCP server not found");
        this.mcp.mergeRecords([server]);
        return { status: await this.mcp.test(server.id) };
      },
      listSkills: async (params) => this.host.call<{ skills?: UserSkillRecord[] }>("skills.list", params).then((result) => ({
        skills: result.skills ?? [],
      })),
      createSkill: async (params) => this.host.call<{ skill: UserSkillRecord }>("skills.create", params),
      updateSkill: async (params) => this.host.call<{ skill: UserSkillRecord }>("skills.update", params),
      readSkill: async (params) => this.host.call<{ skill: UserSkillRecord | null; body: string | null }>("skills.read", params),
      removeSkill: async (params) => this.host.call<{ ok?: boolean }>("skills.remove", params),
      setSkillEnabled: async (params) => this.host.call<{ skill: UserSkillRecord }>("skills.setEnabled", params),
      setSkillScope: async (params) => this.host.call<{ skill: UserSkillRecord }>("skills.setScope", params),
      saveRevision: async (params) => this.host.call<{ revision: unknown }>("session.saveRevision", params),
      listRevisions: async (params) => this.host.call<{ revisions?: unknown[] }>("session.listRevisions", params)
        .then((result) => ({ revisions: result.revisions ?? [] })),
      activateRevision: async (params) => {
        const sessionId = requiredString(params.sessionId, "sessionId");
        await this.sidecar.call("agent.disposeSession", { sessionId }).catch(() => undefined);
        const result = await this.host.call<{ messages?: unknown[] }>("session.activateRevision", params);
        return { messages: result.messages ?? [] };
      },
      advertiseTools: async (tools: RacpRelayTool[]) => {
        const rejected = tools
          .filter((tool) => tool.requiresWorkspace)
          .map((tool) => ({ name: tool.name, reason: "workspace tools cannot be relayed" }));
        return { accepted: tools.filter((tool) => !tool.requiresWorkspace), rejected };
      },
      openTerminal: async (params) => {
        const sessionId = requiredString(params.sessionId, "sessionId");
        const session = await this.getSession(sessionId);
        const catalog = await this.host.call<{ effective?: { available?: boolean } }>(
          "commandShells.list",
        );
        if (!catalog.effective?.available) {
          throw new RacpError("REMOTE_SHELL_UNAVAILABLE", "no remote shell is available");
        }
        return this.terminals.open({
          sessionId,
          cwd: requiredRoot(session),
          shell: "/bin/bash",
          ...(typeof params.columns === "number" ? { columns: params.columns } : {}),
          ...(typeof params.rows === "number" ? { rows: params.rows } : {}),
        });
      },
      writeTerminal: async (params) => {
        this.terminals.write(requiredString(params.terminalId, "terminalId"), {
          ...(typeof params.data === "string" ? { data: params.data } : {}),
          ...(typeof params.text === "string" ? { text: params.text } : {}),
        });
      },
      resizeTerminal: async (params) => {
        this.terminals.resize(
          requiredString(params.terminalId, "terminalId"),
          typeof params.columns === "number" ? params.columns : 80,
          typeof params.rows === "number" ? params.rows : 24,
        );
      },
      closeTerminal: async (params) => {
        this.terminals.close(requiredString(params.terminalId, "terminalId"));
      },
    };
  }

  async handleHostNotification(method: string, params: unknown): Promise<void> {
    if (method === "permissions.request") {
      const request = params as PendingToolRequest;
      this.agentHost.ingest({
        sessionId: request.sessionId,
        turnId: this.activeTurns.get(request.sessionId),
        ts: Date.now(),
        event: { type: "tool_permission_request", request },
      });
      return;
    }
    if (method === "plans.changed") {
      await this.syncPlanningState(String((params as { sessionId?: unknown }).sessionId ?? ""));
    }
    if (method === "plugins.execute") {
      await this.executeMcpTool(params as {
        executionId: string;
        sessionId?: string;
        toolCallId?: string;
        toolName?: string;
        args?: unknown;
      });
    }
  }

  async handleSidecarNotification(method: string, params: unknown): Promise<void> {
    if (method !== "agent.event" || !params) return;
    await this.handleAgentEvent(params as AgentEventEnvelope);
  }

  private createRuntime(): RuntimePort {
    return {
      prompt: async (request: TurnStartRequest) => this.prompt(request),
      stop: async (sessionId) => this.sidecar.call("agent.stop", { sessionId }),
      abort: async (sessionId) => {
        this.agentHost.markAborting(sessionId);
        await this.sidecar.call("agent.abort", { sessionId });
      },
      respondInput: async (resolution: AskToolResolution) => {
        await this.sidecar.call("asktool.resolve", resolution);
      },
      isBusy: (sessionId) => this.activeTurns.has(sessionId),
    };
  }

  private createSessions(): SessionPort {
    return {
      get: async (sessionId) => {
        try {
          const session = await this.getSession(sessionId);
          return this.toAgentSummary(session, await this.projectIndex(), permissionMode((await this.settings()).defaultPermissionMode));
        } catch {
          return null;
        }
      },
      history: async (sessionId, options) => {
        const result = await this.host.call<{ session?: HostSession | null }>("session.get", {
          id: sessionId,
          messageLimit: options.limit,
        });
        const messages = result.session?.messages ?? [];
        const end = options.beforeItemId ? messages.findIndex((message) => message.id === options.beforeItemId) : messages.length;
        const cut = end === -1 ? messages.length : end;
        const start = Math.max(0, cut - options.limit);
        return {
          items: messages.slice(start, cut).map((message) => ({
            id: message.id,
            turnId: this.activeTurns.get(sessionId) ?? "",
            itemType: message.role === "tool" ? ("tool" as const) : ("message" as const),
            status: message.status === "streaming" ? ("streaming" as const) : ("completed" as const),
            createdAt: message.createdAt,
            ...(message.parentToolCallId ? { parentToolCallId: message.parentToolCallId } : {}),
            ...(message.agentName ? { agentName: message.agentName } : {}),
            content: message,
          })),
          hasMore: start > 0,
        };
      },
    };
  }

  private createApprovals(): ApprovalPort {
    return {
      resolveTool: async (requestId, decision) => {
        await this.host.call("permissions.resolve", { requestId, decision });
      },
      resolveContract: async (input) => {
        const pending = await this.host.call<{ plans?: Array<{ id: string; turnId?: string; toolCallId?: string }> }>(
          "plans.pending",
          { sessionId: input.sessionId },
        );
        const proposal = (pending.plans ?? []).find((candidate) => candidate.id === input.proposalId);
        if (!proposal) throw new RacpError("NOT_FOUND", `proposal ${input.proposalId} is not pending`);
        const result = await this.host.call("plans.resolve", {
          proposalId: input.proposalId,
          sessionId: input.sessionId,
          turnId: proposal.turnId ?? "",
          toolCallId: proposal.toolCallId ?? "",
          action: input.action,
          ...(input.permissionMode ? { targetPermissionMode: input.permissionMode } : {}),
          ...(input.version !== undefined ? { version: input.version } : {}),
        });
        if (input.action === "approve") await this.dispatchPlanExecutions(input.sessionId);
        void result;
      },
      listPendingTools: async (sessionId) => {
        const result = await this.host.call<{ requests?: PendingToolRequest[] }>("permissions.pending", {
          ...(sessionId ? { sessionId } : {}),
        });
        return result.requests ?? [];
      },
    };
  }

  private createQueueStore(): QueueStore {
    return {
      listAll: async () => {
        const result = await this.host.call<{ entries?: Array<Record<string, unknown>> }>("session.queueList", {});
        return (result.entries ?? []).map((entry) => this.queueRecord(entry));
      },
      push: async (record) => {
        await this.host.call("session.queuePush", {
          id: record.id,
          sessionId: record.sessionId,
          principal: record.principalSubject,
          ...(record.idempotencyKey ? { idempotencyKey: record.idempotencyKey } : {}),
          inputHash: record.inputHash,
          content: record.content,
          ...(record.attachments ? { attachments: record.attachments } : {}),
          permissionMode: record.effectivePermissionMode,
        });
      },
      remove: async (id) => {
        const result = await this.host.call<{ removed?: boolean }>("session.queueRemove", { id });
        return result.removed === true;
      },
      prioritize: async (id) => {
        await this.host.call("session.queuePrioritize", { id });
      },
    };
  }

  private async prompt(request: TurnStartRequest): Promise<{ turnId: string }> {
    let session = await this.getSession(request.sessionId);
    let revisionMeta: {
      rootUserId?: string;
      revisionCount?: number;
      activeRevision?: number;
    } | undefined;
    if (request.truncateFromMessageId || request.truncateBefore !== undefined) {
      await this.sidecar.call("agent.abort", { sessionId: request.sessionId }).catch(() => undefined);
      await this.finishTurn(request.sessionId, "aborted", "TURN_ABORTED");
      const truncated = await this.host.call<{
        revision?: {
          rootUserId?: string;
          revisionCount?: number;
          activeRevision?: number;
        } | null;
      }>("session.truncateFrom", {
        sessionId: request.sessionId,
        ...(request.truncateFromMessageId ? { fromMessageId: request.truncateFromMessageId } : {}),
        ...(request.truncateBefore !== undefined ? { truncateBefore: request.truncateBefore } : {}),
      });
      revisionMeta = truncated.revision ?? undefined;
      await this.sidecar.call("agent.disposeSession", { sessionId: request.sessionId }).catch(() => undefined);
      session = await this.getSession(request.sessionId);
    }
    const launch = await this.resolveLaunch(session, request.effectivePermissionMode);
    const turn = await this.host.call<{ turnId?: string }>("session.beginTurn", {
      sessionId: request.sessionId,
      providerId: launch.providerId,
      modelId: launch.modelId,
    });
    const turnId = String(turn.turnId ?? "").trim();
    if (!turnId) throw new RacpError("INTERNAL", "session.beginTurn returned no turn");
    this.activeTurns.set(request.sessionId, turnId);

    const userMessage: UiMessage = {
      id: request.messageId?.trim() || `user_${turnId}`,
      role: "user",
      content: request.content,
      createdAt: new Date().toISOString(),
      status: "complete",
      ...(request.attachments?.length ? { attachments: request.attachments.map((attachment) => ({
        kind: attachment.kind,
        name: attachment.name,
        ref: attachment.path,
        ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
        ...(attachment.size !== undefined ? { size: attachment.size } : {}),
      })) } : {}),
      ...(revisionMeta?.revisionCount ? {
        revisionRootId: revisionMeta.rootUserId,
        revisionCount: revisionMeta.revisionCount,
        activeRevision: revisionMeta.activeRevision,
      } : {}),
    };
    await this.host.call("session.appendMessage", {
      sessionId: request.sessionId,
      message: userMessage,
      turnId,
    });
    this.persistedMessages.add(userMessage.id);
    await this.emit({
      sessionId: request.sessionId,
      turnId,
      ts: Date.now(),
      event: { type: "message_start", message: userMessage },
    });
    await this.emit({
      sessionId: request.sessionId,
      turnId,
      ts: Date.now(),
      event: { type: "message_end", message: userMessage },
    });
    const result = await this.sidecar.call<{ accepted?: boolean; turnId?: string }>("agent.prompt", {
      ...launch.sidecarParams,
      turnId,
      content: request.content,
      ...(request.attachments?.length ? { attachments: request.attachments } : {}),
      userMessageId: userMessage.id,
    });
    if (result.accepted !== true) throw new RacpError("AGENT_UNAVAILABLE", "remote agent runtime rejected the turn");
    return { turnId };
  }

  private async resolveLaunch(session: HostSession, permissionOverride?: "ask" | "accept-edits" | "auto") {
    const [settings, providersResult, shellCatalog] = await Promise.all([
      this.settings(),
      this.host.call<{ providers?: RuntimeProvider[] }>("providers.list", { includeDisabled: false }),
      this.host.call<{ effective?: { id: string; dialect: string; available?: boolean } }>("commandShells.list"),
    ]);
    const providers = providersResult.providers ?? [];
    const provider =
      providers.find((item) => item.id === session.providerId) ??
      providers.find((item) => item.id === settings.defaultProviderId) ??
      providers.find((item) => item.authKind === "none" || item.enabled !== false) ??
      providers[0];
    if (!provider) throw new RacpError("MODEL_NOT_CONFIGURED", "the remote Host has no provider configured");
    if (provider.authKind !== "none") {
      const secret = await this.host.call<{ value?: string }>("providers.getSecret", { id: provider.id });
      if (!secret.value) throw new RacpError("PROVIDER_SECRET_MISSING", "the remote provider credential is missing");
      (provider as RuntimeProvider & { apiKey?: string }).apiKey = secret.value;
    }
    const fallbackModelId = typeof settings.defaultModelId === "string" ? settings.defaultModelId : undefined;
    const modelId =
      (provider.id === session.providerId ? session.modelId : undefined) ??
      (provider.id === settings.defaultProviderId ? fallbackModelId : undefined) ??
      provider.models?.[0]?.id ??
      provider.defaultModelId;
    if (!modelId) throw new RacpError("MODEL_NOT_CONFIGURED", "the remote provider has no model selected");
    const binding = provider.models?.find((item) => item.id === modelId);
    const modelConfig = modelConfigWithBinding(genericModelConfig(modelId, provider.baseUrl ?? ""), binding ?? null);
    const capabilities = capabilitiesFromModelConfig(modelConfig);
    const shell = shellCatalog.effective;
    if (!shell?.available) throw new RacpError("REMOTE_SHELL_UNAVAILABLE", "no remote command shell is available");
    const projectPath = session.projectPath?.trim() || undefined;
    this.sessionProjects.set(session.id, projectPath ?? null);
    const [projectInstructions, subagents, activeSkills, activeMcp] = await Promise.all([
      loadInstructionChain(projectPath ?? null),
      loadSubagentDefinitions(projectPath ?? null),
      this.host.call<{ skills?: Array<{ id: string; name: string; description?: string }> }>(
        "skills.active",
        { ...(projectPath ? { projectPath } : {}) },
      ),
      this.host.call<{ servers?: McpServerRecord[] }>("mcp.active", {
        projectPath: projectPath ?? null,
      }),
    ]);
    this.mcp.mergeRecords(activeMcp.servers ?? []);
    const mcpTools = await this.mcp.toolsForProject(projectPath);
    const effectivePermission = permissionOverride ?? permissionMode(
      isGlobalPermissionMode(session.permissionMode) ? session.permissionMode : settings.defaultPermissionMode,
    );
    void effectivePermission;
    return {
      providerId: provider.id,
      modelId,
      projectPath,
      sidecarParams: {
        sessionId: session.id,
        mode: mode(session.mode),
        thinkingLevel: session.thinkingLevel ?? "off",
        commandShell: shell,
        scratchDir: join(this.dataDir, "scratch", session.id),
        attachmentsDir: join(this.dataDir, "attachments"),
        ...(projectPath ? { projectPath } : {}),
      ...(projectInstructions ? { projectInstructions } : {}),
      subagents: subagents.definitions,
      pluginSkills: (activeSkills.skills ?? []).map((skill) => ({
        id: skill.id,
        name: skill.name,
        ...(skill.description ? { description: skill.description } : {}),
      })) satisfies PluginSkillDef[],
      pluginTools: mcpTools.map((tool) => ({
        name: tool.fullName,
        description: tool.description,
        parameters: tool.schema ?? { type: "object", properties: {} },
        risk: "medium" as const,
      })) satisfies PluginToolDef[],
      provider: {
          id: provider.id,
          name: provider.name,
          ...(provider.vendorKey ? { vendorKey: provider.vendorKey } : {}),
          ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
          modelId,
          apiKey: (provider as RuntimeProvider & { apiKey?: string }).apiKey ?? "",
          ...(provider.authKind ? { authKind: provider.authKind } : {}),
          ...(provider.apiStyle ? { apiStyle: provider.apiStyle } : {}),
          ...optionalProviderHeaders(provider.headers),
          supportsReasoning: capabilities.supportsReasoning,
          supportedThinkingLevels: [...capabilities.supportedThinkingLevels],
          supportsVision: visionFromModelConfig(modelConfig),
          modelConfig,
        },
      },
    };
  }

  private async executeMcpTool(request: {
    executionId: string;
    sessionId?: string;
    toolCallId?: string;
    toolName?: string;
    args?: unknown;
  }): Promise<void> {
    let payload: Record<string, unknown>;
    try {
      if (!request.sessionId || typeof request.toolName !== "string") {
        throw new RacpError("INVALID_ARGUMENT", "remote MCP execution is malformed");
      }
      const session = await this.getSession(request.sessionId);
      const result = await this.mcp.callTool(request.toolName, request.args, session.projectPath ?? null);
      payload = {
        executionId: request.executionId,
        ok: true,
        content: result ?? null,
      };
    } catch (error) {
      payload = {
        executionId: request.executionId,
        ok: false,
        errorCode: (error as { code?: string; errorCode?: string }).errorCode ??
          (error as { code?: string }).code ?? "TOOL_FAILED",
        content: { error: error instanceof Error ? error.message : String(error) },
      };
    }
    await this.host.call("plugins.resolveExecution", payload).catch(() => undefined);
  }

  private async refreshMcpRecords(): Promise<void> {
    const [global, projects] = await Promise.all([
      this.host.call<{ servers?: McpServerRecord[] }>("mcp.list", { level: "global" }),
      this.projectIndex(),
    ]);
    const projectLists = await Promise.all(
      [...projects.values()].map((projectPath) =>
        this.host.call<{ servers?: McpServerRecord[] }>("mcp.list", {
          level: "project",
          projectPath,
        }).catch(() => ({ servers: [] as McpServerRecord[] })),
      ),
    );
    this.mcp.setRecords([
      ...(global.servers ?? []),
      ...projectLists.flatMap((result) => result.servers ?? []),
    ]);
  }

  private async handleAgentEvent(envelope: AgentEventEnvelope): Promise<void> {
    const event = envelope.event;
    const turnId = envelope.turnId ?? this.activeTurns.get(envelope.sessionId);
    if (event.type === "tool_start") {
      this.activeTools.set(`${envelope.sessionId}:${event.toolCallId}`, {
        toolName: event.toolName,
        args: event.args,
        createdAt: new Date(envelope.ts).toISOString(),
        turnId: turnId ?? "",
        ...(envelope.parentToolCallId ? { parentToolCallId: envelope.parentToolCallId } : {}),
        ...(envelope.agentName ? { agentName: envelope.agentName } : {}),
      });
      await this.emit(envelope);
      return;
    }
    if (event.type === "tool_end") {
      const started = this.activeTools.get(`${envelope.sessionId}:${event.toolCallId}`);
      this.activeTools.delete(`${envelope.sessionId}:${event.toolCallId}`);
      const message: UiMessage = {
        id: event.toolCallId,
        role: "tool",
        content: typeof event.result === "string" ? event.result : JSON.stringify(event.result),
        createdAt: started?.createdAt ?? new Date(envelope.ts).toISOString(),
        toolCallId: event.toolCallId,
        toolName: started?.toolName,
        toolArgs: started?.args,
        toolStatus: event.isError ? "error" : "success",
        toolResult: event.result,
        ...(event.toolUsage ? { toolUsage: event.toolUsage } : {}),
        toolCompletedAt: new Date(envelope.ts).toISOString(),
        ...(started ? { toolDurationMs: Math.max(0, envelope.ts - Date.parse(started.createdAt)) } : {}),
        isError: event.isError,
        status: "complete",
        ...(started?.parentToolCallId ? { parentToolCallId: started.parentToolCallId } : {}),
        ...(started?.agentName ? { agentName: started.agentName } : {}),
      };
      await this.persistMessage(envelope.sessionId, message, started?.turnId ?? turnId);
      await this.emit(envelope);
      return;
    }
    if (event.type === "message_end" && !this.persistedMessages.has(event.message.id)) {
      await this.persistMessage(envelope.sessionId, event.message, turnId);
    }
    if (event.type === "agent_end" || event.type === "error") {
      await this.finishTurn(
        envelope.sessionId,
        event.type === "error" ? "error" : "completed",
        event.type === "error" ? event.error.code : undefined,
      );
      if (event.type === "agent_end") {
        const saved = await this.host.call<{
          saved?: { root?: UiMessage } | null;
        }>("session.saveActiveRevision", { sessionId: envelope.sessionId }).catch(() => undefined);
        const root = saved?.saved?.root;
        if (root) {
          await this.emit({
            sessionId: envelope.sessionId,
            turnId,
            ts: Date.now(),
            event: { type: "message_end", message: root },
          });
        }
      }
    }
    await this.emit(envelope);
  }

  private async emit(envelope: AgentEventEnvelope): Promise<void> {
    this.agentHost.ingest(envelope);
  }

  private async persistMessage(sessionId: string, message: UiMessage, turnId?: string): Promise<void> {
    const owner = turnId ?? this.activeTurns.get(sessionId);
    if (!owner) return;
    this.persistedMessages.add(message.id);
    await this.host.call("session.appendMessage", { sessionId, message, turnId: owner });
  }

  private async finishTurn(sessionId: string, status: "completed" | "error" | "aborted", errorCode?: string): Promise<void> {
    const turnId = this.activeTurns.get(sessionId);
    if (!turnId) return;
    this.activeTurns.delete(sessionId);
    await this.host.call("session.endTurn", {
      turnId,
      status,
      ...(errorCode ? { errorCode } : {}),
      createNotification: false,
    }).catch(() => undefined);
  }

  private async dispatchPlanExecutions(sessionId: string): Promise<void> {
    const result = await this.host.call<{ executions?: Array<Record<string, unknown>> }>("plans.queuedExecutions", {});
    for (const raw of result.executions ?? []) {
      if (raw.sessionId !== sessionId || raw.state !== "queued") continue;
        const claim = await this.host.call<{ execution?: { state?: string } }>("plans.claimExecution", {
          executionId: raw.id,
        });
      if (claim?.execution?.state && claim.execution.state !== "running") continue;
      const session = await this.getSession(sessionId);
      const launch = await this.resolveLaunch({ ...session, mode: "agent" });
      const turn = await this.host.call<{ turnId?: string }>("session.beginTurn", {
        sessionId,
        providerId: launch.providerId,
        modelId: launch.modelId,
      });
      const turnId = String(turn.turnId ?? "");
      this.activeTurns.set(sessionId, turnId);
      await this.sidecar.call("agent.executeApprovedPlan", {
        ...launch.sidecarParams,
        mode: "agent",
        turnId,
        execution: raw,
      });
      return;
    }
  }

  private async syncPlanningState(sessionId: string): Promise<void> {
    if (!sessionId) return;
    const result = await this.host.call<{ plans?: Array<Record<string, unknown>>; state?: string }>("plans.pending", { sessionId });
    const proposal = (result.plans ?? [])[0];
    const state = result.state ?? (proposal ? "awaiting_approval" : "inactive");
    const planningEvent = planningEventFrom(proposal, state);
    await this.emit({
      sessionId,
      turnId: this.activeTurns.get(sessionId),
      ts: Date.now(),
      event: planningEvent,
    });
  }

  private async publishChanged(session: HostSession): Promise<void> {
    const settings = await this.settings();
    this.agentHost.publishSessionChange("session.changed", this.toAgentSummary(session, await this.projectIndex(), permissionMode(settings.defaultPermissionMode)));
  }

  private async settings(): Promise<Record<string, unknown>> {
    return this.host.call<Record<string, unknown>>("settings.get");
  }

  private async getSession(sessionId: string): Promise<HostSession> {
    const result = await this.host.call<{ session?: HostSession | null }>("session.get", { id: sessionId, messageLimit: 1 });
    if (!result.session) throw new RacpError("NOT_FOUND", `session ${sessionId} is unknown`);
    return result.session;
  }

  private async projectIndex(): Promise<Map<string, string>> {
    const result = await this.host.call<{ projects?: Array<{ id?: number; path?: string }> }>("projects.list");
    return new Map((result.projects ?? [])
      .filter((project) => project.path)
      .map((project) => [String(project.id ?? project.path), project.path!]));
  }

  private toAgentSummary(
    session: HostSession,
    projects: Map<string, string>,
    defaultPermission: "ask" | "accept-edits" | "auto",
  ): AgentSessionSummary {
    const projectId = [...projects].find(([, path]) => path === session.projectPath)?.[0];
    return {
      id: session.id,
      title: session.title,
      ...(projectId ? { projectId } : {}),
      ...(session.projectPath ? { workspaceLabel: basename(session.projectPath) } : {}),
      mode: mode(session.mode),
      permissionMode: isGlobalPermissionMode(session.permissionMode) ? session.permissionMode : defaultPermission,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  private toRacpSession(session: HostSession, projects: Map<string, string>): RacpSession {
    const projectId = [...projects].find(([, path]) => path === session.projectPath)?.[0];
    return {
      id: session.id,
      title: session.title,
      ...(projectId ? { projectId } : {}),
      ...(session.projectPath ? { workspaceLabel: basename(session.projectPath) } : {}),
      mode: mode(session.mode),
      ...(session.providerId ? { providerId: session.providerId } : {}),
      ...(session.modelId ? { modelId: session.modelId } : {}),
      thinkingLevel: session.thinkingLevel ?? "off",
      messageCount: session.messageCount ?? 0,
      status: toRacpStatus(session.id, this.activeTurns),
      planningState: "inactive",
      permissionMode: permissionMode(session.permissionMode),
      queuedTurnIds: [],
      revision: 0,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  private queueRecord(entry: Record<string, unknown>): QueuedTurnRecord {
    return {
      id: String(entry.id ?? ""),
      sessionId: String(entry.sessionId ?? ""),
      principalSubject: String(entry.principal ?? "desktop"),
      content: String(entry.content ?? ""),
      ...(Array.isArray(entry.attachments) ? { attachments: entry.attachments as QueuedTurnRecord["attachments"] } : {}),
      effectivePermissionMode: permissionMode(entry.permissionMode),
      ...(entry.idempotencyKey ? { idempotencyKey: String(entry.idempotencyKey) } : {}),
      inputHash: String(entry.inputHash ?? ""),
      createdAt: Date.parse(String(entry.createdAt ?? "")) || 0,
    };
  }
}

function planningEventFrom(
  proposal: Record<string, unknown> | undefined,
  rawState: string | undefined,
): Omit<PlanningStateEvent, "sessionId"> & { type: "planning_state" } {
  const state = rawState ?? (proposal ? "awaiting_approval" : "inactive");
  return {
    type: "planning_state" as const,
    state: state === "awaiting_approval" || state === "planning" ? state : "inactive",
    ...(proposal ? {
      kind: normalizeProposalKind(proposal.kind),
      proposalId: stringOrUndefined(proposal.id),
      title: stringOrUndefined(proposal.title),
      question: stringOrUndefined(proposal.question),
      markdown: stringOrUndefined(proposal.plan),
      ...(proposal.artifact ? { artifact: proposal.artifact as PlanProposal["artifact"] } : {}),
      ...(typeof proposal.version === "number" ? { version: proposal.version } : {}),
      proposal: proposal as PlanProposal,
    } : {}),
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new RacpError("INVALID_ARGUMENT", `${field} is required`);
  return value;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function requiredRoot(session: HostSession): string {
  const path = session.projectPath?.trim();
  if (!path) throw new RacpError("WORKSPACE_REQUIRED", "the session has no remote workspace");
  return path;
}

export type { FsReadResult, RemoteDirectoryResult, WorkspaceDiff };
