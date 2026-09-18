/**
 * Loopback RACP bridge for external session control (CC Connect).
 *
 * Serves the desktop's in-process Agent Host over RACP-WS on `127.0.0.1` with
 * an ephemeral port, so a locally-running integration (cc-connect) can drive
 * real PI-Desktop sessions from messaging platforms. Every turn admitted here
 * flows through the same Agent Host ports the renderer uses
 * (`agentPrompt`/`agentStop`/...), so external messages appear as real turns
 * in the normal desktop UI, share its queue, and resolve approvals through
 * the desktop's permission handler.
 *
 * External control is an explicit, scoped capability (ADR 0297):
 * - the bridge is off until enabled, and loopback-only by construction;
 * - one dedicated device identity with `viewer/controller/approver` roles is
 *   minted for the bridge — never `owner`, so session deletion, device
 *   revocation, and project registration stay desktop-side;
 * - the device token lives in a 0600 file beside the discovery file, which
 *   itself never contains the token.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentHost, SessionSummary } from "@pi-desktop/agent-host";
import {
  bindRacpWebSocket,
  createAttachmentStaging,
  DeviceTokenAuthenticator,
  hashToken,
  newDeviceToken,
  RacpServer,
  type DeviceCredentialStore,
  type RacpHostOperations,
  type WsBinding,
} from "@pi-desktop/racp";
import { createHostOperations, loadOrCreateHostId, toSessionSummary } from "@pi-desktop/host-runtime";
import { IPC, RACP_DEFAULT_LIMITS, type RacpRole } from "@pi-desktop/shared";

type IpcInvoke = (channel: string, args: readonly unknown[]) => Promise<unknown>;

type HostLike = {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
};

export type RacpBridgeStatus = {
  running: boolean;
  url?: string;
  host?: string;
  port?: number;
  hostId?: string;
  startedAt?: string;
};

export type RacpBridge = {
  start(): Promise<RacpBridgeStatus>;
  stop(): Promise<void>;
  status(): RacpBridgeStatus;
  /** Absolute path of the 0600 discovery file (never contains the token). */
  readonly discoveryFile: string;
  /** Absolute path of the 0600 device-token file handed to cc-connect. */
  readonly tokenFile: string;
};

export type RacpBridgeOptions = {
  dataDir: string;
  version: string;
  agentHost: AgentHost;
  getHost: () => HostLike | null;
  invoke: IpcInvoke;
  channels: typeof IPC.invoke;
  isSessionBusy: (sessionId: string) => boolean;
  /** Notify the renderer that the durable session catalog changed. */
  notifySessionsChanged?: () => void;
  credentialStore: DeviceCredentialStore;
  log: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
};

const DISCOVERY_FILE = "racp-bridge.json";
const TOKEN_FILE = "racp-bridge.token";
const BRIDGE_DEVICE_LABEL = "cc-connect";
/** The external principal controls turns and answers approvals; nothing more. */
const BRIDGE_ROLES: RacpRole[] = ["viewer", "controller", "approver"];

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}

export function createRacpBridge(options: RacpBridgeOptions): RacpBridge {
  const discoveryFile = join(options.dataDir, DISCOVERY_FILE);
  const tokenFile = join(options.dataDir, TOKEN_FILE);
  const { channels, invoke, getHost } = options;

  let binding: WsBinding | null = null;
  let server: RacpServer | null = null;
  let status: RacpBridgeStatus = { running: false };

  const requireHost = (): HostLike => {
    const host = getHost();
    if (!host) throw new Error("host-core is not running");
    return host;
  };

  async function projectPathFor(projectId: string | undefined): Promise<string | undefined> {
    if (!projectId) return undefined;
    const host = requireHost();
    const result = await host.call<{ projects?: Array<{ id: number; path: string }> }>("projects.list", {});
    const project = (result.projects ?? []).find((row) => String(row.id) === projectId);
    if (!project) throw Object.assign(new Error(`project ${projectId} is unknown`), { errorCode: "NOT_FOUND" });
    return project.path;
  }

  async function listSummaries(): Promise<SessionSummary[]> {
    const host = requireHost();
    const result = await host.call<{ sessions?: Array<Record<string, unknown>> }>("session.list", {});
    const projects = await host.call<{ projects?: Array<{ id: number; path: string; name: string }> }>("projects.list", {});
    const byPath = new Map((projects.projects ?? []).map((row) => [row.path, String(row.id)]));
    return (result.sessions ?? []).map((record) => {
      const summary = toSessionSummary(record as Parameters<typeof toSessionSummary>[0]);
      const projectId = typeof record.projectPath === "string" ? byPath.get(record.projectPath) : undefined;
      return projectId ? { ...summary, projectId } : summary;
    });
  }

  /**
   * Catalog mutations go through the registered session IPC handlers so the
   * renderer, sidecar bookkeeping, and host-core stay on the exact desktop
   * paths; reads reuse the shared host-backed catalog.
   */
  function buildOperations(): RacpHostOperations {
    const base = createHostOperations({
      getHost,
      runtime: {
        isBusy: (sessionId) => options.isSessionBusy(sessionId),
        compact: async (sessionId) => {
          const result = (await invoke(channels.agentCompact, [{ sessionId }])) as { accepted?: boolean } | undefined;
          return { accepted: result?.accepted !== false };
        },
      },
      browseRoot: options.dataDir,
    });
    const refresh = () => options.notifySessionsChanged?.();
    return {
      ...base,
      attachments: createAttachmentStaging({
        root: join(options.dataDir, "attachments"),
        maxAttachmentBytes: RACP_DEFAULT_LIMITS.maxAttachmentBytes,
      }),
      sessions: {
        ...base.sessions,
        async create(input) {
          const projectPath = await projectPathFor(input.projectId);
          const result = (await invoke(channels.sessionCreate, [
            {
              ...(input.title ? { title: input.title } : {}),
              ...(input.mode ? { mode: input.mode } : {}),
              ...(input.providerId ? { providerId: input.providerId } : {}),
              ...(input.modelId ? { modelId: input.modelId } : {}),
              ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
              ...(projectPath ? { projectPath } : {}),
            },
          ])) as { session?: { id?: string } | null };
          const id = result.session?.id;
          if (!id) throw new Error("session.create returned no session");
          if (input.permissionMode) {
            await invoke(channels.sessionConfigure, [id, { mode: input.mode ?? "agent", permissionMode: input.permissionMode }]);
          }
          refresh();
          const summary = (await listSummaries()).find((candidate) => candidate.id === id);
          if (!summary) throw new Error("session vanished after create");
          return summary;
        },
        async configure(sessionId, input) {
          if (options.isSessionBusy(sessionId)) {
            throw Object.assign(new Error("the session has an active turn"), { errorCode: "CONFLICT" });
          }
          await invoke(channels.sessionConfigure, [
            sessionId,
            {
              ...(input.mode ? { mode: input.mode } : {}),
              ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
              ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
              ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
              ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
            },
          ]);
          refresh();
          const summary = (await listSummaries()).find((candidate) => candidate.id === sessionId);
          if (!summary) throw Object.assign(new Error(`session ${sessionId} is unknown`), { errorCode: "NOT_FOUND" });
          return summary;
        },
        async fork(sessionId, input) {
          const result = (await invoke(channels.sessionFork, [
            { sessionId, ...(input.title ? { title: input.title } : {}), ...(input.throughMessageId ? { throughMessageId: input.throughMessageId } : {}) },
          ])) as { session?: { id?: string } | null };
          const id = result.session?.id;
          if (!id) throw new Error("session.fork returned no session");
          refresh();
          const summary = (await listSummaries()).find((candidate) => candidate.id === id);
          if (!summary) throw new Error("forked session vanished");
          return summary;
        },
        async rename(sessionId, title) {
          await invoke(channels.sessionRename, [sessionId, title]);
          refresh();
        },
        async delete(sessionId) {
          if (options.isSessionBusy(sessionId)) {
            throw Object.assign(new Error("the session has an active turn"), { errorCode: "CONFLICT" });
          }
          await invoke(channels.sessionDelete, [sessionId]);
          refresh();
        },
      },
    };
  }

  async function ensureBridgeDevice(store: DeviceCredentialStore): Promise<string> {
    const existing = (await readFile(tokenFile, "utf8").then((t) => t.trim()).catch(() => null)) ?? null;
    if (existing) {
      const device = await store.findDeviceByTokenHash(hashToken(existing));
      if (device && !device.revokedAt && BRIDGE_ROLES.every((role) => device.roles.includes(role))) {
        return existing;
      }
    }
    const token = newDeviceToken();
    await store.saveDevice({
      deviceId: `dev_cc_${randomBytes(8).toString("hex")}`,
      label: BRIDGE_DEVICE_LABEL,
      roles: [...BRIDGE_ROLES],
      tokenHash: hashToken(token),
      createdAt: new Date().toISOString(),
    });
    await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
    await writeFile(tokenFile, `${token}\n`, { encoding: "utf8", mode: 0o600 });
    options.log("info", "racp bridge device minted", { roles: BRIDGE_ROLES });
    return token;
  }

  return {
    discoveryFile,
    tokenFile,
    async start() {
      if (binding) return status;
      const host = getHost();
      if (!host) throw new Error("host-core is not running");
      const authenticator = new DeviceTokenAuthenticator(options.credentialStore);
      await ensureBridgeDevice(options.credentialStore);
      const hostId = await loadOrCreateHostId(options.dataDir);
      server = new RacpServer({
        agentHost: options.agentHost,
        operations: buildOperations(),
        authenticator,
        hostId,
        serverVersion: options.version,
        log: options.log,
      });
      binding = await bindRacpWebSocket({ server, authenticator, host: "127.0.0.1", port: 0, log: options.log });
      const startedAt = new Date().toISOString();
      status = {
        running: true,
        host: binding.address.host,
        port: binding.address.port,
        url: `ws://${binding.address.host}:${binding.address.port}/v1/racp/ws`,
        startedAt,
      };
      await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
      await writeJsonAtomic(discoveryFile, {
        url: status.url,
        host: status.host,
        port: status.port,
        version: options.version,
        pid: process.pid,
        startedAt,
      });
      options.log("info", "racp bridge ready", { host: status.host, port: status.port });
      return status;
    },
    async stop() {
      if (!binding && !server) return;
      const currentBinding = binding;
      const currentServer = server;
      binding = null;
      server = null;
      currentServer?.close();
      await currentBinding?.close().catch((error: unknown) => {
        options.log("warn", "racp bridge stop failed", { error: String(error) });
      });
      await rm(discoveryFile, { force: true });
      status = { running: false };
      options.log("info", "racp bridge stopped");
    },
    status: () => status,
  };
}
