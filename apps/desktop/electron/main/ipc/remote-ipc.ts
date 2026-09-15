import { dialog } from "electron";
import { ErrorCodes, IPC, type RemoteConnectionInput } from "@pi-desktop/shared";
import type { RemoteManager } from "../remote-manager";
import type { IpcRegistrar } from "./types";

export type RemoteIpcDependencies = {
  registrar: IpcRegistrar;
  getRemoteManager: () => RemoteManager | null;
  getMainWindow: () => Electron.BrowserWindow | null;
  /** Localized title for the identity-file picker dialog. */
  getSelectIdentityFileTitle: () => string;
};

function requiredId(value: unknown, field: string): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) throw Object.assign(new Error(`${field} is required`), { errorCode: "INVALID_ARGUMENT" });
  return id;
}

/** Register the remote SSH connection, project, relay, and terminal channels. */
export function registerRemoteIpc({
  registrar,
  getRemoteManager,
  getMainWindow,
  getSelectIdentityFileTitle,
}: RemoteIpcDependencies): void {
  const { handle } = registrar;
  // Resolved per call: the manager is opened during boot, after registration.
  const requireRemoteManager = () => {
    const manager = getRemoteManager();
    if (!manager) throw new Error("remote manager unavailable");
    return manager;
  };
  handle(IPC.invoke.remoteListConnections, async () => {
    const remoteManager = requireRemoteManager();
    return { connections: remoteManager.listConnections() };
  });
  handle(IPC.invoke.remoteRefreshConnections, async () => {
    const remoteManager = requireRemoteManager();
    return { connections: await remoteManager.refreshConnections() };
  });
  handle(IPC.invoke.remoteDiscoverSshHosts, async () => {
    const remoteManager = requireRemoteManager();
    return remoteManager.discoverSshHosts();
  });
  handle(IPC.invoke.remoteExportConnections, async () => {
    const remoteManager = requireRemoteManager();
    return { export: remoteManager.exportConnections() };
  });
  handle(IPC.invoke.remoteImportConnections, async (text: string) => {
    const remoteManager = requireRemoteManager();
    return remoteManager.importConnections(typeof text === "string" ? text : "");
  });
  handle(IPC.invoke.remoteTestConnection, async (input: { connectionId?: string }) => {
    const remoteManager = requireRemoteManager();
    return remoteManager.testConnection(requiredId(input.connectionId, "connectionId"));
  });
  handle(IPC.invoke.remoteAddConnection, async (input: RemoteConnectionInput) => {
    const remoteManager = requireRemoteManager();
    return { connection: await remoteManager.addConnection(input) };
  });
  handle(IPC.invoke.remoteUpdateConnection, async (input: { connectionId?: string; input?: RemoteConnectionInput }) => {
    const remoteManager = requireRemoteManager();
    if (!input.input) {
      throw Object.assign(new Error("connection input is required"), { errorCode: ErrorCodes.INVALID_ARGUMENT });
    }
    return {
      connection: await remoteManager.updateConnection(
        requiredId(input.connectionId, "connectionId"),
        input.input,
      ),
    };
  });
  handle(IPC.invoke.remoteRemoveConnection, async (input: { connectionId?: string }) => {
    const remoteManager = requireRemoteManager();
    await remoteManager.removeConnection(requiredId(input.connectionId, "connectionId"));
    return { ok: true };
  });
  handle(IPC.invoke.remoteConnect, async (input: { connectionId?: string }) => {
    const remoteManager = requireRemoteManager();
    return { connection: await remoteManager.connect(requiredId(input.connectionId, "connectionId")) };
  });
  handle(IPC.invoke.remoteDisconnect, async (input: { connectionId?: string }) => {
    const remoteManager = requireRemoteManager();
    await remoteManager.disconnect(requiredId(input.connectionId, "connectionId"));
    return { ok: true };
  });
  handle(IPC.invoke.remoteUpgradeHost, async (input: { connectionId?: string }) => {
    const remoteManager = requireRemoteManager();
    return { connection: await remoteManager.upgradeHost(requiredId(input.connectionId, "connectionId")) };
  });
  handle(IPC.invoke.remoteRevokeDevice, async (input: { connectionId?: string }) => {
    const remoteManager = requireRemoteManager();
    return remoteManager.revokeDevice(requiredId(input.connectionId, "connectionId"));
  });
  handle(IPC.invoke.remoteDiagnostics, async (input: { connectionId?: string }) => {
    const remoteManager = requireRemoteManager();
    return remoteManager.diagnostics(requiredId(input.connectionId, "connectionId"));
  });
  handle(IPC.invoke.remoteImportProvider, async (input: { connectionId?: string; providerId?: string }) => {
    const remoteManager = requireRemoteManager();
    return remoteManager.importProvider(
      requiredId(input.connectionId, "connectionId"),
      requiredId(input.providerId, "providerId"),
    );
  });
  handle(IPC.invoke.remoteDeleteProvider, async (input: { connectionId?: string; providerId?: string }) => {
    const remoteManager = requireRemoteManager();
    return remoteManager.deleteProvider(
      requiredId(input.connectionId, "connectionId"),
      requiredId(input.providerId, "providerId"),
    );
  });
  handle(IPC.invoke.remoteListProjects, async () => {
    const remoteManager = requireRemoteManager();
    return { projects: remoteManager.listProjects() };
  });
  handle(IPC.invoke.remoteAddProject, async (input: { connectionId?: string; remotePath?: string; name?: string }) => {
    const remoteManager = requireRemoteManager();
    return {
      workspace: await remoteManager.addProject({
        connectionId: requiredId(input.connectionId, "connectionId"),
        remotePath: requiredId(input.remotePath, "remotePath"),
        ...(input.name ? { name: input.name } : {}),
      }),
    };
  });
  handle(IPC.invoke.remoteOpenProject, async (input: { projectId?: string }) => {
    const remoteManager = requireRemoteManager();
    return { workspace: await remoteManager.openProject(requiredId(input.projectId, "projectId")) };
  });
  handle(IPC.invoke.remoteRemoveProject, async (input: { projectId?: string }) => {
    const remoteManager = requireRemoteManager();
    await remoteManager.removeProject(requiredId(input.projectId, "projectId"));
    return { ok: true };
  });
  handle(IPC.invoke.remoteBrowseDirectory, async (input: { connectionId?: string; path?: string }) => {
    const remoteManager = requireRemoteManager();
    return remoteManager.browseDirectory({
      connectionId: requiredId(input.connectionId, "connectionId"),
      ...(input.path ? { path: input.path } : {}),
    });
  });
  handle(IPC.invoke.remoteSelectIdentityFile, async () => {
    const options: Electron.OpenDialogOptions = {
      title: getSelectIdentityFileTitle(),
      properties: ["openFile"],
      filters: [
        { name: "SSH identity files", extensions: ["pem", "key", "id_rsa", "id_ed25519"] },
        { name: "All files", extensions: ["*"] },
      ],
    };
    const parent = getMainWindow();
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  handle(IPC.invoke.remoteRelayCatalog, async (input: { connectionId?: string }) => {
    const remoteManager = requireRemoteManager();
    return remoteManager.relayCatalog(requiredId(input.connectionId, "connectionId"));
  });
  handle(IPC.invoke.remoteRelaySet, async (input: {
    connectionId?: string;
    toolNames?: string[];
  }) => {
    const remoteManager = requireRemoteManager();
    if (!Array.isArray(input.toolNames) || input.toolNames.some((name) => typeof name !== "string")) {
      throw Object.assign(new Error("toolNames must be a string array"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    return remoteManager.setRelayTools(
      requiredId(input.connectionId, "connectionId"),
      input.toolNames,
    );
  });
  handle(IPC.invoke.remoteTerminalOpen, async (input: {
    sessionId?: string;
    columns?: number;
    rows?: number;
  }) => {
    const remoteManager = requireRemoteManager();
    return remoteManager.openTerminal({
      sessionId: requiredId(input.sessionId, "sessionId"),
      ...(input.columns !== undefined ? { columns: input.columns } : {}),
      ...(input.rows !== undefined ? { rows: input.rows } : {}),
    });
  });
  handle(IPC.invoke.remoteTerminalWrite, async (input: {
    sessionId?: string;
    terminalId?: string;
    text?: string;
  }) => {
    const remoteManager = requireRemoteManager();
    await remoteManager.writeTerminal({
      sessionId: requiredId(input.sessionId, "sessionId"),
      terminalId: requiredId(input.terminalId, "terminalId"),
      text: typeof input.text === "string" ? input.text : "",
    });
    return { ok: true };
  });
  handle(IPC.invoke.remoteTerminalResize, async (input: {
    sessionId?: string;
    terminalId?: string;
    columns?: number;
    rows?: number;
  }) => {
    const remoteManager = requireRemoteManager();
    await remoteManager.resizeTerminal({
      sessionId: requiredId(input.sessionId, "sessionId"),
      terminalId: requiredId(input.terminalId, "terminalId"),
      columns: Math.max(2, Math.min(500, Math.floor(Number(input.columns ?? 80)))),
      rows: Math.max(2, Math.min(300, Math.floor(Number(input.rows ?? 24)))),
    });
    return { ok: true };
  });
  handle(IPC.invoke.remoteTerminalClose, async (input: {
    sessionId?: string;
    terminalId?: string;
  }) => {
    const remoteManager = requireRemoteManager();
    await remoteManager.closeTerminal({
      sessionId: requiredId(input.sessionId, "sessionId"),
      terminalId: requiredId(input.terminalId, "terminalId"),
    });
    return { ok: true };
  });
}
