import { basename } from "node:path";

import {
  AgentHost,
  MemoryQueueStore,
  RacpError,
  type ApprovalPort,
  type PendingToolRequest,
  type RuntimePort,
  type SessionPort,
  type SessionSummary,
  type TurnStartRequest,
} from "@pi-desktop/agent-host";
import type {
  AgentEventEnvelope,
  AskToolResolution,
  RacpApprovalResult,
  RacpItemSummary,
  RacpPermissionMode,
  UiMessage,
} from "@pi-desktop/shared";
import { IPC, isGlobalPermissionMode } from "@pi-desktop/shared";

type IpcInvoke = (channel: string, args: readonly unknown[]) => Promise<unknown>;

type HostLike = {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
};

export type AgentHostBridgeOptions = {
  invoke: IpcInvoke;
  channels: typeof IPC.invoke;
  getHost: () => HostLike | null;
  log: (level: "info" | "warn", message: string, data?: Record<string, unknown>) => void;
};

type HostSessionRecord = {
  id: string;
  title?: string;
  projectId?: string;
  projectPath?: string;
  mode?: string;
  permissionMode?: string;
  planningState?: string;
  createdAt?: string;
  updatedAt?: string;
  messages?: UiMessage[];
};

/**
 * Electron Main's adapter around the headless Agent Host module (rollout R1,
 * D374/D375). The module wraps the existing registered IPC handlers through
 * `invokeIpc` rather than the renderer, `host.proxy`, or host-core RPC, so the
 * local permission and persistence behavior is reused unchanged. Later steps
 * move handler logic into the module; the wire contract does not change.
 */
export function createAgentHostBridge(options: AgentHostBridgeOptions) {
  const abortingSessions = new Set<string>();
  const resolvingViaModule = new Set<string>();

  const requireHost = (): HostLike => {
    const host = options.getHost();
    if (!host) throw new RacpError("AGENT_UNAVAILABLE", "host is not running", { retriable: true });
    return host;
  };

  const runtime: RuntimePort = {
    async prompt(request: TurnStartRequest) {
      const summary = await sessions.get(request.sessionId);
      if (summary && summary.permissionMode !== request.effectivePermissionMode) {
        // The local prompt path runs under the session's durable permission
        // mode. A per-turn ceiling needs runtime support that lands with the
        // RACP-WS binding; until then a capped turn fails closed.
        throw new RacpError(
          "FORBIDDEN",
          "the local runtime cannot apply a per-turn permission ceiling yet",
          { details: { effectivePermissionMode: request.effectivePermissionMode } },
        );
      }
      const result = (await options.invoke(options.channels.agentPrompt, [
        {
          sessionId: request.sessionId,
          content: request.content,
          ...(request.attachments ? { attachments: request.attachments } : {}),
        },
      ])) as { accepted?: boolean; turnId: string };
      return { turnId: result.turnId };
    },
    async stop(sessionId: string) {
      const result = (await options.invoke(options.channels.agentStop, [{ sessionId }])) as
        | { requested?: boolean }
        | undefined;
      return { requested: result?.requested ?? true };
    },
    async abort(sessionId: string) {
      abortingSessions.add(sessionId);
      try {
        await options.invoke(options.channels.agentAbort, [{ sessionId }]);
      } catch (error) {
        abortingSessions.delete(sessionId);
        throw error;
      }
    },
    async respondInput(resolution: AskToolResolution) {
      await options.invoke(options.channels.askToolResolve, [resolution]);
    },
  };

  const approvals: ApprovalPort = {
    async resolveTool(requestId, decision) {
      resolvingViaModule.add(requestId);
      try {
        await options.invoke(options.channels.toolResolvePermission, [{ requestId, decision }]);
      } finally {
        resolvingViaModule.delete(requestId);
      }
    },
    async resolveContract(input) {
      // The plans.resolve handler needs the submitting turn and tool call,
      // which only the host's pending proposal row carries.
      const host = requireHost();
      const pending = await host.call<{ plans?: Array<{ id: string; turnId?: string; toolCallId?: string }> }>(
        "plans.pending",
        { sessionId: input.sessionId },
      );
      const proposal = (pending.plans ?? []).find((candidate) => candidate.id === input.proposalId);
      if (!proposal) throw new RacpError("NOT_FOUND", `proposal ${input.proposalId} is not pending`);
      resolvingViaModule.add(input.proposalId);
      try {
        await options.invoke(options.channels.plansResolve, [
          {
            proposalId: input.proposalId,
            sessionId: input.sessionId,
            turnId: proposal.turnId ?? "",
            toolCallId: proposal.toolCallId ?? "",
            action: input.action,
            ...(input.version !== undefined ? { version: input.version } : {}),
            ...(input.permissionMode ? { targetPermissionMode: input.permissionMode } : {}),
          },
        ]);
      } finally {
        resolvingViaModule.delete(input.proposalId);
      }
    },
    async listPendingTools(sessionId) {
      const host = options.getHost();
      if (!host) return [];
      const result = await host.call<{ requests?: PendingToolRequest[] }>("permissions.pending", {
        ...(sessionId ? { sessionId } : {}),
      });
      return result.requests ?? [];
    },
  };

  const sessions: SessionPort = {
    async get(sessionId) {
      const record = await fetchSession(sessionId);
      return record ? toSummary(record) : null;
    },
    async history(sessionId, { limit, beforeItemId }) {
      const record = await fetchSession(sessionId);
      const messages = record?.messages ?? [];
      const end = beforeItemId ? messages.findIndex((message) => message.id === beforeItemId) : messages.length;
      const cut = end === -1 ? messages.length : end;
      const start = Math.max(0, cut - limit);
      return {
        items: messages.slice(start, cut).map(toItem),
        hasMore: start > 0,
      };
    },
  };

  async function fetchSession(sessionId: string): Promise<HostSessionRecord | null> {
    const host = options.getHost();
    if (!host) return null;
    const result = await host.call<{ session?: HostSessionRecord | null }>("session.get", { id: sessionId });
    return result.session ?? null;
  }

  const agentHost = new AgentHost({
    runtime,
    sessions,
    approvals,
    queueStore: new MemoryQueueStore(),
  });

  return {
    agentHost,
    /** Feed one normalized runtime event; `agent_end` after an abort is `turn.interrupted`. */
    ingest(envelope: AgentEventEnvelope): void {
      const interrupted =
        envelope.event.type === "agent_end" && abortingSessions.has(envelope.sessionId);
      if (envelope.event.type === "agent_end" || envelope.event.type === "error") {
        abortingSessions.delete(envelope.sessionId);
      }
      try {
        agentHost.ingest(envelope, { interrupted });
      } catch (error) {
        options.log("warn", "agent host ingest failed", {
          sessionId: envelope.sessionId,
          type: envelope.event.type,
          error: String(error),
        });
      }
    },
    /** The desktop card or an IPC caller settled an approval outside the module. */
    settleApproval(
      approvalId: string,
      outcome: { decision?: RacpApprovalResult["decision"]; permissionMode?: string },
    ): void {
      if (resolvingViaModule.has(approvalId)) return;
      const permissionMode = isGlobalPermissionMode(outcome.permissionMode)
        ? (outcome.permissionMode as RacpPermissionMode)
        : undefined;
      try {
        agentHost.settleApprovalExternally(approvalId, {
          ...(outcome.decision ? { decision: outcome.decision } : {}),
          ...(permissionMode ? { permissionMode } : {}),
        });
      } catch (error) {
        options.log("warn", "agent host settle failed", { approvalId, error: String(error) });
      }
    },
    markAborting(sessionId: string): void {
      abortingSessions.add(sessionId);
    },
  };
}

export type AgentHostBridge = ReturnType<typeof createAgentHostBridge>;

function toSummary(record: HostSessionRecord): SessionSummary {
  const mode = record.mode === "plan" || record.mode === "goal" ? record.mode : "agent";
  const permissionMode: RacpPermissionMode =
    record.permissionMode === "accept-edits" || record.permissionMode === "auto" ? record.permissionMode : "ask";
  const planningState =
    record.planningState === "planning" || record.planningState === "awaiting_approval"
      ? record.planningState
      : "inactive";
  return {
    id: record.id,
    title: record.title ?? "",
    ...(record.projectId ? { projectId: record.projectId } : {}),
    ...(record.projectPath ? { workspaceLabel: basename(record.projectPath) } : {}),
    mode,
    permissionMode,
    planningState,
    createdAt: record.createdAt ?? new Date(0).toISOString(),
    updatedAt: record.updatedAt ?? record.createdAt ?? new Date(0).toISOString(),
  };
}

function toItem(message: UiMessage): RacpItemSummary {
  const turnId = (message as { turnId?: string }).turnId ?? "";
  return {
    id: message.id,
    turnId,
    itemType: "message",
    status: message.status === "streaming" ? "streaming" : "completed",
    createdAt: message.createdAt,
    ...(message.parentToolCallId ? { parentToolCallId: message.parentToolCallId } : {}),
    ...(message.agentName ? { agentName: message.agentName } : {}),
    content: message,
  };
}
