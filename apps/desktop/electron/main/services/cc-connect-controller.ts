/**
 * CC Connect controller: the host-owned integration point between PI-Desktop
 * and a locally-managed cc-connect daemon (ADR 0297).
 *
 * Two responsibilities, both off until the user enables them:
 * - the loopback RACP bridge (`racp-bridge.ts`), which serves the desktop's
 *   Agent Host to the cc-connect `pidesktop` backend; and
 * - the cc-connect process itself: detect an existing executable, start it
 *   with user-chosen arguments (typically `--config <plugin-data>/config.toml`
 *   pointing at PI-managed configuration), stop/restart it, and keep a bounded
 *  , redacted log tail.
 *
 * The controller never downloads a cc-connect binary and never writes into
 * `~/.cc-connect`; PI-managed configuration lives under the desktop data dir
 * and the plugin's own data directory.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import type { DeviceCredentialStore } from "@pi-desktop/racp";

import { createRacpBridge, type RacpBridge, type RacpBridgeStatus } from "../bootstrap/racp-bridge.js";

export type CcConnectProcessStatus = {
  running: boolean;
  pid?: number;
  command?: string;
  startedAt?: string;
  exitCode?: number | null;
};

export type CcConnectStatus = {
  version: string;
  bridge: RacpBridgeStatus & { enabled: boolean };
  process: CcConnectProcessStatus;
};

export type CcConnectStartInput = {
  /** Executable to run; defaults to the detected or persisted `cc-connect`. */
  command?: string;
  /** Arguments (e.g. `["--config", "<path>"]`); persisted for restarts. */
  args?: string[];
};

export type CcConnectController = {
  status(): Promise<CcConnectStatus>;
  setBridgeEnabled(enabled: boolean): Promise<CcConnectStatus>;
  detectBinary(): Promise<{ found: boolean; path?: string; version?: string }>;
  startProcess(input: CcConnectStartInput): Promise<CcConnectProcessStatus>;
  stopProcess(): Promise<CcConnectProcessStatus>;
  restartProcess(): Promise<CcConnectProcessStatus>;
  logs(input?: { limit?: number }): Promise<{ lines: string[] }>;
  /** Boot-time restore: enable the bridge when the user left it enabled. */
  autoStart(): Promise<void>;
  /** Graceful shutdown hook. */
  dispose(): Promise<void>;
};

export type CcConnectControllerOptions = {
  dataDir: string;
  version: string;
  agentHost: Parameters<typeof createRacpBridge>[0]["agentHost"];
  getHost: () => { call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> } | null;
  invoke: (channel: string, args: readonly unknown[]) => Promise<unknown>;
  channels: Parameters<typeof createRacpBridge>[0]["channels"];
  isSessionBusy: (sessionId: string) => boolean;
  notifySessionsChanged?: () => void;
  credentialStore: DeviceCredentialStore;
  log: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
};

type StateFile = {
  bridgeEnabled?: boolean;
  command?: string;
  lastArgs?: string[];
};

const STATE_DIR = "cc-connect";
const STATE_FILE = "state.json";
const LOG_FILE = "cc-connect.log";
const LOG_LINE_LIMIT = 1000;
const LOG_FILE_LIMIT_BYTES = 1024 * 1024;
const STOP_GRACE_MS = 5000;
const VERSION_TIMEOUT_MS = 4000;

function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  return writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }).then(() => rename(temp, path));
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Replace anything that looks like a local bridge/device token before storing. */
function redact(line: string): string {
  return line
    .replace(/\b(pdt1|ppt1)_[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/\b(pdt1|ppt1)\.[A-Za-z0-9._-]+\b/g, "[redacted]");
}

export function createCcConnectController(options: CcConnectControllerOptions): CcConnectController {
  const stateDir = join(options.dataDir, STATE_DIR);
  const stateFile = join(stateDir, STATE_FILE);
  const logFile = join(stateDir, LOG_FILE);

  const bridge: RacpBridge = createRacpBridge({
    dataDir: options.dataDir,
    version: options.version,
    agentHost: options.agentHost,
    getHost: options.getHost,
    invoke: options.invoke,
    channels: options.channels,
    isSessionBusy: options.isSessionBusy,
    notifySessionsChanged: options.notifySessionsChanged,
    credentialStore: options.credentialStore,
    log: options.log,
  });

  let child: ChildProcess | null = null;
  let processStartedAt: string | undefined;
  let processCommand: string | undefined;
  let lastExitCode: number | null | undefined;
  const logTail: string[] = [];

  async function loadState(): Promise<StateFile> {
    return (await readJson<StateFile>(stateFile)) ?? {};
  }

  async function saveState(patch: Partial<StateFile>): Promise<void> {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const state = { ...(await loadState()), ...patch };
    await writeJsonAtomic(stateFile, state);
  }

  function appendLog(stream: "stdout" | "stderr", chunk: string): void {
    for (const rawLine of chunk.split(/\r?\n/)) {
      if (!rawLine) continue;
      const line = `${new Date().toISOString()} [${stream}] ${redact(rawLine)}`;
      logTail.push(line);
      if (logTail.length > LOG_LINE_LIMIT) logTail.splice(0, logTail.length - LOG_LINE_LIMIT);
    }
    void (async () => {
      try {
        await mkdir(stateDir, { recursive: true, mode: 0o700 });
        let oversize = false;
        try {
          oversize = (await stat(logFile)).size > LOG_FILE_LIMIT_BYTES;
        } catch {
          oversize = false;
        }
        if (oversize) {
          await rm(logFile, { force: true });
        }
        const handle = await open(logFile, "a", 0o600);
        try {
          await handle.write(`${redact(chunk)}\n`);
        } finally {
          await handle.close();
        }
      } catch {
        // Log persistence is best-effort; the in-memory tail still works.
      }
    })();
  }

  function processStatus(): CcConnectProcessStatus {
    const running = Boolean(child && child.exitCode === null && !child.killed);
    return {
      running,
      ...(running && child?.pid ? { pid: child.pid } : {}),
      ...(processCommand ? { command: processCommand } : {}),
      ...(processStartedAt ? { startedAt: processStartedAt } : {}),
      ...(!running && lastExitCode !== undefined ? { exitCode: lastExitCode } : {}),
    };
  }

  async function resolveExecutable(explicit?: string): Promise<string> {
    if (explicit?.trim()) return explicit.trim();
    const state = await loadState();
    if (state.command?.trim()) return state.command.trim();
    const { access, constants } = await import("node:fs/promises");
    const dirs = [...(process.env.PATH?.split(":") ?? []), "/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local/bin"), join(homedir(), "go/bin")];
    for (const dir of dirs) {
      if (!dir) continue;
      const candidate = join(dir, "cc-connect");
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
    throw Object.assign(new Error("cc-connect executable was not found on this machine; install it or set its path in the CC Connect panel"), { errorCode: "NOT_FOUND" });
  }

  async function binaryVersion(command: string): Promise<string | undefined> {
    return new Promise((resolveVersion) => {
      const probe = spawn(command, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      const timer = setTimeout(() => {
        probe.kill("SIGKILL");
        resolveVersion(undefined);
      }, VERSION_TIMEOUT_MS);
      probe.stdout?.on("data", (chunk) => {
        out += String(chunk);
      });
      probe.once("exit", () => {
        clearTimeout(timer);
        resolveVersion(out.trim().split(/\r?\n/)[0] || undefined);
      });
      probe.once("error", () => {
        clearTimeout(timer);
        resolveVersion(undefined);
      });
    });
  }

  const controller: CcConnectController = {
    async status() {
      const state = await loadState();
      return {
        version: options.version,
        bridge: { ...bridge.status(), enabled: state.bridgeEnabled === true },
        process: processStatus(),
      };
    },

    async setBridgeEnabled(enabled) {
      await saveState({ bridgeEnabled: enabled });
      if (enabled) {
        await bridge.start();
      } else {
        await bridge.stop();
      }
      return controller.status();
    },

    async detectBinary() {
      try {
        const command = await resolveExecutable();
        const version = await binaryVersion(command);
        return { found: true, path: command, ...(version ? { version } : {}) };
      } catch {
        return { found: false };
      }
    },

    async startProcess(input) {
      if (processStatus().running) return processStatus();
      const command = await resolveExecutable(input?.command);
      const args = (input?.args ?? (await loadState()).lastArgs ?? []).map(String);
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      const spawned = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
      child = spawned;
      processCommand = [command, ...args].join(" ");
      processStartedAt = new Date().toISOString();
      lastExitCode = undefined;
      options.log("info", "cc-connect process started", { pid: spawned.pid });
      spawned.stdout?.setEncoding("utf8");
      spawned.stderr?.setEncoding("utf8");
      spawned.stdout?.on("data", (chunk: string) => appendLog("stdout", chunk));
      spawned.stderr?.on("data", (chunk: string) => appendLog("stderr", chunk));
      spawned.once("exit", (code) => {
        lastExitCode = code;
        options.log("warn", "cc-connect process exited", { code: code ?? null });
        if (child === spawned) child = null;
      });
      await saveState({ command, lastArgs: args });
      return processStatus();
    },

    async stopProcess() {
      const running = child;
      if (!running) return processStatus();
      child = null;
      await new Promise<void>((resolveStop) => {
        const timer = setTimeout(() => {
          running.kill("SIGKILL");
          resolveStop();
        }, STOP_GRACE_MS);
        running.once("exit", () => {
          clearTimeout(timer);
          resolveStop();
        });
        running.kill("SIGTERM");
      });
      options.log("info", "cc-connect process stopped");
      return processStatus();
    },

    async restartProcess() {
      const state = await loadState();
      await controller.stopProcess();
      return controller.startProcess({ ...(state.command ? { command: state.command } : {}), ...(state.lastArgs ? { args: state.lastArgs } : {}) });
    },

    async logs(input) {
      const limit = Math.min(Math.max(input?.limit ?? 200, 1), LOG_LINE_LIMIT);
      return { lines: logTail.slice(-limit) };
    },

    async autoStart() {
      const state = await loadState();
      if (state.bridgeEnabled === true) {
        await bridge.start().catch((error: unknown) => {
          options.log("warn", "racp bridge autostart failed", { error: String(error) });
        });
      }
    },

    async dispose() {
      await bridge.stop().catch(() => undefined);
      await controller.stopProcess();
    },
  };

  return controller;
}
