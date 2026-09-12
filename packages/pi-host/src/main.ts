import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import {
  APP_VERSION,
  ErrorCodes,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
} from "@pi-desktop/shared";
import { RacpWsServer } from "@pi-desktop/agent-host";
import { HostAuthentication } from "./auth.js";
import { PiHostService } from "./pi-host.js";
import { RpcProcess } from "./rpc-process.js";

const HOST_PROXY_ALLOWED = new Set([
  "tools.execute",
  "tools.abort",
  "tools.list",
  "session.get",
  "session.appendMessage",
  "session.appendCompaction",
  "session.replaceMessages",
  "workspace.get",
  "plans.enter",
  "plans.submit",
  "plans.pending",
  "plans.abort",
  "project.instructions.resolve",
  "provider.resolveSubagentModel",
  "app.health",
]);

type RuntimeMetadata = {
  pid: number;
  port: number;
  version: string;
  protocolVersion: number;
  storageSchemaVersion: number;
  startedAt: string;
};

function usage(): never {
  process.stderr.write(`pi-host ${APP_VERSION}
Usage:
  pi-host [--data-dir PATH] [--host-core PATH] [--sidecar PATH]
  pi-host --status [--runtime-dir PATH]
  pi-host --stop [--runtime-dir PATH]
  pi-host --revoke-device [--runtime-dir PATH]
  pi-host --provider-import < JSON
  pi-host --provider-delete < provider id
`);
  process.exit(2);
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) usage();
  return value;
}

function hasArgument(name: string): boolean {
  return process.argv.includes(name);
}

function runtimeDir(): string {
  return argumentValue("--runtime-dir") ?? argumentValue("--data-dir") ?? join(homedir(), ".pi-desktop", "host", "runtime");
}

function hostCorePath(): string {
  const explicit = argumentValue("--host-core") ?? process.env.PI_DESKTOP_HOST_BIN;
  const candidates = [
    explicit,
    process.env.PI_HOST_CORE_BIN,
    join(import.meta.dirname, "host-core", "pi-desktop-host-core"),
    join(process.cwd(), "host-core", "pi-desktop-host-core"),
    join(import.meta.dirname, "..", "host-core", "pi-desktop-host-core"),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return resolve(candidate);
  }
  throw Object.assign(new Error("host-core binary not found"), { errorCode: ErrorCodes.REMOTE_HOST_START_FAILED });
}

function sidecarPath(): string {
  const explicit = argumentValue("--sidecar") ?? process.env.PI_HOST_AGENT_SIDECAR;
  const candidates = [
    explicit,
    join(import.meta.dirname, "agent-runtime", "sidecar.js"),
    join(import.meta.dirname, "..", "agent-runtime", "sidecar.js"),
    join(process.cwd(), "agent-runtime", "sidecar.js"),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return resolve(candidate);
  }
  throw Object.assign(new Error("agent sidecar not found"), { errorCode: ErrorCodes.REMOTE_HOST_START_FAILED });
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function metadataPath(dir = runtimeDir()): string {
  return join(dir, "host.json");
}

function readMetadata(dir = runtimeDir()): RuntimeMetadata | null {
  try {
    return JSON.parse(readFileSync(metadataPath(dir), "utf8")) as RuntimeMetadata;
  } catch {
    return null;
  }
}

async function controlCommands(): Promise<boolean> {
  if (hasArgument("--version")) {
    process.stdout.write(`${APP_VERSION}\n`);
    return true;
  }
  if (hasArgument("--status")) {
    const metadata = readMetadata();
    let running = false;
    if (metadata) {
      try {
        process.kill(metadata.pid, 0);
        running = true;
      } catch {
        running = false;
      }
    }
    process.stdout.write(`${JSON.stringify({ running, ...metadata }, null, 2)}\n`);
    return true;
  }
  if (hasArgument("--stop")) {
    const metadata = readMetadata();
    if (!metadata) {
      process.stderr.write("pi-host is not registered\n");
      process.exit(1);
    }
    try {
      process.kill(metadata.pid, "SIGTERM");
      process.stdout.write("stop requested\n");
    } catch {
      process.exit(1);
    }
    return true;
  }
  if (hasArgument("--revoke-device")) {
    const dir = runtimeDir();
    mkdirSync(dir, { recursive: true });
    const revoked = HostAuthentication.create(dir).revokeDevice();
    process.stdout.write(`${revoked ? "revoked" : "no device"}\n`);
    return true;
  }
  if (hasArgument("--provider-import")) {
    await importProviders();
    return true;
  }
  if (hasArgument("--provider-delete")) {
    await deleteProvider();
    return true;
  }
  return false;
}

async function importProviders(): Promise<void> {
  const dir = runtimeDir();
  mkdirSync(dir, { recursive: true });
  const host = new RpcProcess({
    command: hostCorePath(),
    label: "host-core",
    env: { ...process.env, PI_DESKTOP_DATA_DIR: dir },
  });
  try {
    await host.call("app.handshake", { protocolVersion: PROTOCOL_VERSION });
    const input = JSON.parse(readFileSync(0, "utf8")) as Record<string, unknown> | Array<Record<string, unknown>>;
    const providers = Array.isArray(input) ? input : [input];
    for (const provider of providers) {
      await host.call("providers.create", provider);
    }
    process.stdout.write(`${JSON.stringify({ imported: providers.length })}\n`);
  } finally {
    await host.dispose();
  }
}

async function deleteProvider(): Promise<void> {
  const dir = runtimeDir();
  mkdirSync(dir, { recursive: true });
  const host = new RpcProcess({
    command: hostCorePath(),
    label: "host-core",
    env: { ...process.env, PI_DESKTOP_DATA_DIR: dir },
  });
  try {
    await host.call("app.handshake", { protocolVersion: PROTOCOL_VERSION });
    const id = readFileSync(0, "utf8").trim();
    if (!id) throw new Error("provider id is required");
    await host.call("providers.delete", { id });
    process.stdout.write(`${JSON.stringify({ deleted: true })}\n`);
  } finally {
    await host.dispose();
  }
}

async function run(): Promise<void> {
  if (await controlCommands()) return;
  if (process.platform !== "linux") {
    throw Object.assign(new Error("pi-host supports Linux remotes only"), {
      errorCode: ErrorCodes.REMOTE_OS_UNSUPPORTED,
    });
  }
  const dir = runtimeDir();
  mkdirSync(dir, { recursive: true });
  const auth = HostAuthentication.create(dir);
  const host = new RpcProcess({
    command: hostCorePath(),
    label: "host-core",
    env: { ...process.env, PI_DESKTOP_DATA_DIR: dir },
    onStderr: (text) => process.stderr.write(`[host-core] ${text}`),
  });
  const sidecar = new RpcProcess({
    command: process.execPath,
    args: [sidecarPath()],
    label: "agent-sidecar",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    onStderr: (text) => process.stderr.write(`[agent-sidecar] ${text}`),
    handleRequest: async (request) => {
      const params = request.params as { method?: string; params?: unknown };
      const method = params.method;
      if (!method || !HOST_PROXY_ALLOWED.has(method)) {
        throw Object.assign(new Error(`host proxy method is not allowed: ${method ?? ""}`), {
          errorCode: ErrorCodes.FORBIDDEN,
        });
      }
      return host.call(method, params.params ?? {});
    },
  });
  const service = new PiHostService(host, sidecar, dir);
  const unsubscribeHost = host.onNotification((method, params) => {
    void service.handleHostNotification(method, params).catch((error) => {
      process.stderr.write(`host notification failed: ${String(error)}\n`);
    });
  });
  const unsubscribeSidecar = sidecar.onNotification((method, params) => {
    void service.handleSidecarNotification(method, params).catch((error) => {
      process.stderr.write(`agent notification failed: ${String(error)}\n`);
    });
  });
  await service.start();
  const server = new RacpWsServer({
    agentHost: service.agentHost,
    profile: service.remoteProfile(),
    authenticate: (token) => auth.authenticate(token),
    serverInfo: {
      name: "pi-desktop-agent-host",
      version: APP_VERSION,
      hostProtocolVersion: PROTOCOL_VERSION,
      storageSchemaVersion: SCHEMA_VERSION,
    },
  });
  await server.whenReady();
  const port = Number(new URL(server.address).port);
  const metadata: RuntimeMetadata = {
    pid: process.pid,
    port,
    version: APP_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    storageSchemaVersion: SCHEMA_VERSION,
    startedAt: new Date().toISOString(),
  };
  writeJson(metadataPath(dir), metadata);
  writeFileSync(join(dir, "host.pid"), `${process.pid}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    event: "pi-host.ready",
    endpoint: server.address,
    port,
    pairingRequired: !auth.hasDevice,
    ...(auth.pairing ? { pairing: auth.pairing } : {}),
  })}\n`);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      await server.close();
      unsubscribeHost();
      unsubscribeSidecar();
      await sidecar.dispose();
      await host.dispose();
      process.exit(0);
    })();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`unhandled rejection: ${String(reason)}\n`);
  });
  await new Promise<void>(() => undefined);
}

run().catch((error) => {
  const errorCode = (error as { errorCode?: string }).errorCode ?? ErrorCodes.REMOTE_HOST_START_FAILED;
  process.stderr.write(`${JSON.stringify({ event: "pi-host.failed", errorCode, message: error instanceof Error ? error.message : String(error) })}\n`);
  process.exit(1);
});
