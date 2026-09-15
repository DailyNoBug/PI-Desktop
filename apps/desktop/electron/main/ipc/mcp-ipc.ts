import { ErrorCodes, IPC, parseMcpImport, type ActivationScope, type AgentCapabilityQuery, type MarketSource, type McpServerInput, type McpServerRecord, type McpServerStatus } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { McpRegistrySearchResult } from "../mcp-registry-catalog";
import type { RemoteManager } from "../remote-manager";
import type { UserMcpRuntime } from "../user-mcp";
import type { IpcRegistrar } from "./types";

export type McpIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  getRemoteManager: () => RemoteManager | null;
  userMcp: UserMcpRuntime;
  currentWorkspacePath: () => string | null;
  refreshUserMcp: (projectPath?: string | null) => Promise<McpServerRecord[]>;
  describeError: (error: unknown) => string;
  sendToRenderer: (channel: string, payload?: unknown) => void;
  searchMcpMarket: (
    query: string,
    sources: MarketSource[],
    options?: { more?: boolean },
  ) => Promise<McpRegistrySearchResult>;
};

/** Register user-owned MCP server registry and runtime channels. */
export function registerMcpIpc({
  registrar,
  getHost,
  getRemoteManager,
  userMcp,
  currentWorkspacePath,
  refreshUserMcp,
  describeError,
  sendToRenderer,
  searchMcpMarket,
}: McpIpcDependencies): void {
  let host: HostProcess | null = null;
  const handle = (channel: string, fn: (...args: any[]) => Promise<any>) => {
    registrar.handle(channel, async (...args) => {
      host = getHost();
      return fn(...args);
    });
  };

  // Remote MCP is served over the SSH connection bound to the project. The
  // canonical path travels with the result so the host-backed branch and the
  // remote branch agree on which project the query targets.
  const remoteCapabilityContext = (query: { projectPath?: string } = {}) => {
    const projectPath = query.projectPath ?? currentWorkspacePath();
    const context = getRemoteManager?.()?.remoteProjectContext(projectPath);
    return context && projectPath
      ? { ...context, canonicalProjectPath: projectPath }
      : null;
  };

  // The market's source aggregator never touches the host process, so it
  // registers outside the host-bound wrapper.
  registrar.handle(
    IPC.invoke.mcpMarketSearch,
    async ({
      query,
      sources,
      more,
    }: { query?: string; sources?: MarketSource[]; more?: boolean } = {}) =>
      searchMcpMarket(query ?? "", Array.isArray(sources) ? sources : [], { more: more === true }),
  );

handle(IPC.invoke.mcpList, async (query: Partial<AgentCapabilityQuery> = {}) => {
    const remoteTarget = remoteCapabilityContext(query);
    if (remoteTarget) {
      const remoteManager = getRemoteManager?.();
      if (!remoteManager) throw new Error("remote manager unavailable");
      if (query.level !== "global" && query.level !== "project") {
        throw Object.assign(new Error("capability level is required"), { errorCode: ErrorCodes.INVALID_ARGUMENT });
      }
      return remoteManager.listMcp({
        level: query.level,
        projectPath: remoteTarget.canonicalProjectPath,
      });
    }
    if (!host) throw new Error("host unavailable");
    const result = await host.call<{ servers: McpServerRecord[]; statuses?: McpServerStatus[] }>(
      "mcp.list",
      query,
    );
    // Status belongs to the currently open project's active runtime, while the
    // list itself must include disabled records for the settings page.
    await refreshUserMcp(currentWorkspacePath());
    return { servers: result.servers ?? [], statuses: userMcp.listStatuses() };
  });

  handle(IPC.invoke.mcpUpsert, async (server: McpServerInput) => {
    const requestedProjectPath = server.projectPath ?? currentWorkspacePath() ?? undefined;
    const remoteTarget = remoteCapabilityContext({
      projectPath: requestedProjectPath,
    });
    if (remoteTarget) {
      const remoteManager = getRemoteManager?.();
      if (!remoteManager) throw new Error("remote manager unavailable");
      const res = await remoteManager.upsertMcp(server, requestedProjectPath);
      sendToRenderer(IPC.event.pluginChanged, { reason: "mcp", pluginId: res.server?.id });
      return res;
    }
    if (!host) throw new Error("host unavailable");
    const res = await host.call<{ server: McpServerRecord }>("mcp.upsert", { server });
    await refreshUserMcp(currentWorkspacePath());
    sendToRenderer(IPC.event.pluginChanged,{ reason: "mcp", pluginId: res.server?.id });
    return res;
  });

  handle(
    IPC.invoke.mcpRemove,
    async (payload: { id: string } & Partial<AgentCapabilityQuery>) => {
      const remoteTarget = remoteCapabilityContext(payload);
      if (remoteTarget) {
        const remoteManager = getRemoteManager?.();
        if (!remoteManager) throw new Error("remote manager unavailable");
        if (payload.level !== "global" && payload.level !== "project") {
          throw Object.assign(new Error("capability level is required"), { errorCode: ErrorCodes.INVALID_ARGUMENT });
        }
        const res = await remoteManager.removeMcp(payload.id, {
          level: payload.level,
          projectPath: remoteTarget.canonicalProjectPath,
        });
        sendToRenderer(IPC.event.pluginChanged, { reason: "mcp", pluginId: payload.id });
        return res;
      }
      if (!host) throw new Error("host unavailable");
      const res = await host.call("mcp.remove", payload);
      await refreshUserMcp(currentWorkspacePath());
      sendToRenderer(IPC.event.pluginChanged,{ reason: "mcp", pluginId: payload.id });
      return res;
    },
  );

  handle(
    IPC.invoke.mcpSetEnabled,
    async (payload: { id: string; enabled: boolean } & Partial<AgentCapabilityQuery>) => {
      const remoteTarget = remoteCapabilityContext(payload);
      if (remoteTarget) {
        const remoteManager = getRemoteManager?.();
        if (!remoteManager) throw new Error("remote manager unavailable");
        if (payload.level !== "global" && payload.level !== "project") {
          throw Object.assign(new Error("capability level is required"), { errorCode: ErrorCodes.INVALID_ARGUMENT });
        }
        const res = await remoteManager.setMcpEnabled(payload.id, payload.enabled, {
          level: payload.level,
          projectPath: remoteTarget.canonicalProjectPath,
        });
        sendToRenderer(IPC.event.pluginChanged, { reason: "mcp", pluginId: payload.id });
        return res;
      }
      if (!host) throw new Error("host unavailable");
      const res = await host.call("mcp.setEnabled", payload);
      await refreshUserMcp(currentWorkspacePath());
      sendToRenderer(IPC.event.pluginChanged,{ reason: "mcp", pluginId: payload.id });
      return res;
    },
  );

  handle(
    IPC.invoke.mcpSetScope,
    async (payload: { id: string; scope: ActivationScope }) => {
      const remoteTarget = remoteCapabilityContext();
      if (remoteTarget) {
        const remoteManager = getRemoteManager?.();
        if (!remoteManager) throw new Error("remote manager unavailable");
        const res = await remoteManager.setMcpScope(
          payload.id,
          payload.scope as unknown as Record<string, unknown>,
          { level: "global", projectPath: currentWorkspacePath() ?? undefined },
        );
        sendToRenderer(IPC.event.pluginChanged, { reason: "mcp", pluginId: payload.id });
        return res;
      }
      if (!host) throw new Error("host unavailable");
      const res = await host.call("mcp.setScope", payload);
      await refreshUserMcp(currentWorkspacePath());
      sendToRenderer(IPC.event.pluginChanged,{ reason: "mcp", pluginId: payload.id });
      return res;
    },
  );

  handle(
    IPC.invoke.mcpTest,
    async (payload: { id: string } & Partial<AgentCapabilityQuery>) => {
      const remoteTarget = remoteCapabilityContext(payload);
      if (remoteTarget) {
        const remoteManager = getRemoteManager?.();
        if (!remoteManager) throw new Error("remote manager unavailable");
        if (payload.level !== "global" && payload.level !== "project") {
          throw Object.assign(new Error("capability level is required"), { errorCode: ErrorCodes.INVALID_ARGUMENT });
        }
        return remoteManager.testMcp(payload.id, {
          level: payload.level,
          projectPath: remoteTarget.canonicalProjectPath,
        });
      }
      if (!host) throw new Error("host unavailable");
      const query = {
        ...(payload.level ? { level: payload.level } : {}),
        ...(payload.projectPath ? { projectPath: payload.projectPath } : {}),
      } satisfies Partial<AgentCapabilityQuery>;
      const listed = await host.call<{ servers: McpServerRecord[] }>("mcp.list", query);
      // Test may target a project different from the current session. Keep the
      // requested record long enough for the handshake, then restore the
      // current project's active runtime below.
      userMcp.setRecords([
        ...userMcp.listRecords().filter((record) => !listed.servers.some((item) => item.id === record.id)),
        ...(listed.servers ?? []),
      ]);
      const status = await userMcp.test(payload.id);
      await refreshUserMcp(currentWorkspacePath());
      sendToRenderer(IPC.event.pluginChanged,{ reason: "mcp", pluginId: payload.id });
      return { status };
    },
  );

  /**
   * Import a pasted MCP configuration. Servers are saved one at a time so a
   * single bad entry costs that entry rather than the whole paste.
   */
  handle(IPC.invoke.mcpImport, async (payload: { text: string }) => {
    const remoteTarget = remoteCapabilityContext();
    if (remoteTarget) {
      const remoteManager = getRemoteManager?.();
      if (!remoteManager) throw new Error("remote manager unavailable");
      const parsed = parseMcpImport(String(payload?.text ?? ""));
      const imported: McpServerRecord[] = [];
      const failed = [...parsed.skipped];
      const projectPath = currentWorkspacePath() ?? undefined;
      for (const server of parsed.servers) {
        try {
          const res = await remoteManager.upsertMcp(server, projectPath);
          imported.push(res.server);
        } catch (error) {
          failed.push({ id: server.id, reason: describeError(error) });
        }
      }
      if (imported.length) {
        sendToRenderer(IPC.event.pluginChanged, { reason: "mcp" });
      }
      return { imported, failed };
    }
    if (!host) throw new Error("host unavailable");
    const parsed = parseMcpImport(String(payload?.text ?? ""));
    const imported: McpServerRecord[] = [];
    const failed = [...parsed.skipped];
    for (const server of parsed.servers) {
      try {
        const res = await host.call<{ server: McpServerRecord }>("mcp.upsert", { server });
        imported.push(res.server);
      } catch (error) {
        failed.push({ id: server.id, reason: describeError(error) });
      }
    }
    await refreshUserMcp(currentWorkspacePath());
    if (imported.length) {
      sendToRenderer(IPC.event.pluginChanged,{ reason: "mcp" });
    }
    return { imported, failed };
  });

}
