import { spawn, execFile } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createServer } from "node:net";
import type { ChildProcess } from "node:child_process";
import type { RemoteConnection } from "@pi-desktop/shared";

const SSH_TIMEOUT_MS = 15_000;

export type SshExecutionResult = { code: number; stdout: string; stderr: string };
export type EffectiveSshConfig = { hostname: string; user?: string; port: number; identityFile?: string };
export type ProposedHostKeys = { fingerprints: string[]; knownHostsPath: string };

export class SshError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly stage: string,
    readonly exitCode?: number | null,
  ) {
    super(message);
    this.name = "SshError";
  }
}

function openSshTool(name: string): string {
  for (const directory of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new SshError("SSH_NOT_AVAILABLE", `system OpenSSH executable not found: ${name}`, "resolving");
}

export function resolveSshExecutable(): string {
  const explicit = process.env.PI_DESKTOP_SSH_BIN;
  if (explicit && existsSync(explicit)) return explicit;
  return openSshTool(process.platform === "win32" ? "ssh.exe" : "ssh");
}

function configFile(): string {
  return process.env.PI_DESKTOP_SSH_CONFIG ?? join(homedir(), ".ssh", "config");
}

function concreteAliases(line: string): string[] {
  return line
    .replace(/^Host\s+/i, "")
    .split(/\s+/)
    .filter(Boolean)
    .filter((alias) => !/[*?!]/.test(alias));
}

function includePaths(line: string, root: string): string[] {
  return line
    .replace(/^Include\s+/i, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((value) => {
      const expanded = value.startsWith("~") ? join(homedir(), value.slice(1)) : value;
      return isAbsolute(expanded) ? expanded : resolve(root, expanded);
    });
}

/** Read only concrete Host aliases; effective semantics remain OpenSSH's job. */
export function discoverSshAliases(path = configFile()): string[] {
  if (!existsSync(path)) throw new SshError("SSH_CONFIG_NOT_FOUND", `OpenSSH config not found: ${path}`, "resolving");
  const aliases = new Set<string>();
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^Host\s+/i.test(trimmed)) {
      for (const alias of concreteAliases(trimmed)) aliases.add(alias);
    } else if (/^Include\s+/i.test(trimmed)) {
      for (const include of includePaths(trimmed, dirname(path))) {
        try {
          for (const alias of discoverSshAliases(include)) aliases.add(alias);
        } catch {
          // OpenSSH tolerates a missing optional include.
        }
      }
    }
  }
  return [...aliases].sort((a, b) => a.localeCompare(b));
}

function baseArgs(connection: RemoteConnection): string[] {
  if (connection.sshConfigAlias) {
    const args: string[] = [];
    if (connection.user) args.push("-l", connection.user);
    if (connection.port) args.push("-p", String(connection.port));
    if (connection.identityFilePath) args.push("-i", connection.identityFilePath);
    args.push(connection.sshConfigAlias);
    return args;
  }
  const args: string[] = [];
  if (connection.port) args.push("-p", String(connection.port));
  if (connection.user) args.push("-l", connection.user);
  if (connection.identityFilePath) args.push("-i", connection.identityFilePath);
  args.push(connection.hostname ?? connection.displayName);
  return args;
}

function commonArgs(connection: RemoteConnection, password?: string): string[] {
  return [
    ...authenticationArgs(connection, password),
    ...baseArgs(connection),
  ];
}

function authenticationArgs(connection: RemoteConnection, password?: string): string[] {
  return [
    "-o", password === undefined ? "BatchMode=yes" : "BatchMode=no",
    "-o", "ConnectTimeout=10",
    ...(password === undefined ? [] : ["-o", "NumberOfPasswordPrompts=1"]),
  ];
}

type AskpassContext = {
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function askpassContext(password: string): Promise<AskpassContext> {
  const directory = mkdtempSync(join(tmpdir(), "pi-askpass-"));
  const helper = join(directory, "askpass.cjs");
  const launcher = join(directory, process.platform === "win32" ? "askpass.cmd" : "askpass");
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\pi-desktop-askpass-${randomUUID()}`
    : join(directory, "askpass.sock");
  writeFileSync(helper, `${[
    `"use strict";`,
    `const net = require("node:net");`,
    `const socket = net.createConnection(process.argv[2]);`,
    `let value = "";`,
    `socket.on("data", (chunk) => { value += chunk; });`,
    `socket.on("error", () => process.exit(1));`,
    `socket.on("close", () => {`,
    `  if (value) process.stdout.write(value);`,
    `});`,
    "",
  ].join("\n")}\n`, { mode: 0o600 });
  if (process.platform === "win32") {
    writeFileSync(
      launcher,
      `@echo off\r\n"${process.execPath}" "${helper}" "${socketPath}"\r\n`,
      { mode: 0o700 },
    );
  } else {
    writeFileSync(
      launcher,
      `#!/bin/sh\nexec env ELECTRON_RUN_AS_NODE=1 ${shellQuote(process.execPath)} ${shellQuote(helper)} ${shellQuote(socketPath)}\n`,
      { mode: 0o700 },
    );
  }
  const server = createServer((socket) => socket.end(password));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
    if (process.platform !== "win32") chmodSync(socketPath, 0o600);
  } catch (error) {
    server.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    server.close();
    rmSync(directory, { recursive: true, force: true });
  };
  server.once("error", () => {
    cleanup();
  });
  return {
    env: {
      DISPLAY: process.env.DISPLAY ?? "pi-desktop",
      SSH_ASKPASS: launcher,
      SSH_ASKPASS_REQUIRE: "force",
    },
    cleanup,
  };
}

async function run(
  command: string,
  args: string[],
  options: { stdin?: string; timeoutMs?: number; password?: string; signal?: AbortSignal } = {},
): Promise<SshExecutionResult> {
  const askpass = options.password === undefined ? undefined : await askpassContext(options.password);
  return new Promise((resolveRun, rejectRun) => {
    const signal = options.signal;
    const canceled = () => new SshError("SSH_CANCELED", "connection canceled", "connecting");
    if (signal?.aborted) {
      askpass?.cleanup();
      rejectRun(canceled());
      return;
    }
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...(askpass ? { env: { ...process.env, ...askpass.env } } : {}),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let aborted = false;
    const timer = setTimeout(() => {
      child.kill();
    }, options.timeoutMs ?? SSH_TIMEOUT_MS);
    const onAbort = () => {
      aborted = true;
      child.kill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (result: SshExecutionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      askpass?.cleanup();
      resolveRun(result);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      askpass?.cleanup();
      rejectRun(error);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(0, 2 * 1024 * 1024);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(0, 512 * 1024);
    });
    child.on("error", (error) => fail(error));
    child.on("close", (code, closeSignal) => {
      if (aborted) {
        fail(canceled());
      } else if (closeSignal) {
        finish({ code: 124, stdout, stderr: `${stderr}\nconnection timed out`.trim() });
      } else {
        finish({ code: code ?? 1, stdout, stderr });
      }
    });
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

function classify(result: SshExecutionResult, stage: string): SshError {
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  const code =
    result.code === 255 && /permission denied|authentications that can continue|no supported authentication/.test(text)
      ? "SSH_AUTH_FAILED"
      : /host key verification failed|known_hosts/.test(text)
        ? "SSH_HOST_KEY_FAILED"
        : /timed out|connection timed out/.test(text)
          ? "SSH_CONNECTION_TIMEOUT"
          : /could not resolve hostname|not resolve/.test(text)
            ? "SSH_RESOLVE_FAILED"
            : /connection closed by remote|connection reset|broken pipe/.test(text)
              ? "SSH_CONNECTION_CLOSED"
              : stage === "connecting" && result.code === 255
                ? "SSH_CONNECTION_TIMEOUT"
                : "SSH_CONNECTION_CLOSED";
  return new SshError(code, result.stderr.trim() || result.stdout.trim() || `SSH failed (${result.code})`, stage, result.code);
}

export async function effectiveSshConfig(connection: RemoteConnection, signal?: AbortSignal): Promise<EffectiveSshConfig> {
  const config = configFile();
  const args = existsSync(config)
    ? ["-G", "-F", config, connection.sshConfigAlias ?? connection.hostname ?? ""]
    : ["-G", connection.sshConfigAlias ?? connection.hostname ?? ""];
  const result = await run(resolveSshExecutable(), args, { timeoutMs: 5_000, signal });
  if (result.code !== 0) throw classify(result, "resolving");
  const values = new Map<string, string>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^([a-z0-9]+)\s+(.+)$/i);
    if (match) values.set(match[1].toLowerCase(), match[2].trim());
  }
  const hostname = values.get("hostname") ?? connection.hostname ?? connection.sshConfigAlias ?? "";
  if (!hostname) throw new SshError("SSH_HOST_NOT_FOUND", "SSH target has no hostname", "resolving");
  const port = Number(values.get("port") ?? connection.port ?? 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SshError("SSH_RESOLVE_FAILED", `invalid SSH port ${values.get("port") ?? port}`, "resolving");
  }
  return {
    hostname,
    ...(connection.user?.trim() ? { user: connection.user.trim() } : values.get("user") ? { user: values.get("user") } : {}),
    port,
    ...(values.get("identityfile") ? { identityFile: values.get("identityfile")!.replace(/^"|"$/g, "") } : {}),
  };
}

export async function sshProbe(
  connection: RemoteConnection,
  password?: string,
  signal?: AbortSignal,
): Promise<{ os: string; arch: string; home: string; shell: string }> {
  const result = await run(resolveSshExecutable(), [
    ...commonArgs(connection, password),
    "printf 'PI_HOST_PROBE_OS=%s\\nARCH=%s\\nHOME=%s\\nSHELL=%s\\n' \"$(uname -s)\" \"$(uname -m)\" \"$HOME\" \"$SHELL\"",
  ], { password, signal });
  if (result.code !== 0) throw classify(result, "connecting");
  const values = Object.fromEntries(result.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.split("=", 2) as [string, string]));
  return {
    os: values.PI_HOST_PROBE_OS ?? "",
    arch: values.ARCH ?? "",
    home: values.HOME ?? "",
    shell: values.SHELL ?? "",
  };
}

export async function runSshScript(
  connection: RemoteConnection,
  script: string,
  environment: Record<string, string>,
  password?: string,
  signal?: AbortSignal,
): Promise<SshExecutionResult> {
  const envArgs = Object.entries(environment).map(([key, value]) => `${key}=${value}`);
  const result = await run(resolveSshExecutable(), [...commonArgs(connection, password), "env", ...envArgs, "sh", "-s"], {
    stdin: script,
    timeoutMs: 120_000,
    password,
    signal,
  });
  if (result.code !== 0) throw classify(result, "bootstrapping");
  return result;
}

export async function readRemoteRuntimeMetadata(
  connection: RemoteConnection,
  password?: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  const result = await run(resolveSshExecutable(), [
    ...commonArgs(connection, password),
    `sh -c 'METADATA="$HOME/.pi-desktop/host/runtime/host.json"; [ -f "$METADATA" ] || exit 1; PID=$(tr "," "\n" < "$METADATA" | grep ".pid." | tr -cd "0-9"); [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null || exit 1; cat "$METADATA"'`,
  ], { password, signal });
  // The probe script exits 1 (silently) when the metadata file is absent or
  // its Host process is gone; that means "not installed", not a transport
  // failure. Only 255 is OpenSSH's own exit code.
  if (result.code === 255) throw classify(result, "connecting");
  if (result.code !== 0) return null;
  try {
    const value = JSON.parse(result.stdout.trim());
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function knownHostsPath(): string {
  return process.env.PI_DESKTOP_KNOWN_HOSTS_FILE ?? join(homedir(), ".ssh", "known_hosts");
}

function hostKeyNames(config: EffectiveSshConfig): string[] {
  return config.port === 22 ? [config.hostname] : [config.hostname, `[${config.hostname}]:${config.port}`];
}

export async function knownHostAccepted(config: EffectiveSshConfig): Promise<boolean> {
  const path = knownHostsPath();
  if (!existsSync(path)) return false;
  for (const name of hostKeyNames(config)) {
    const result = await new Promise<SshExecutionResult>((resolve, reject) => {
      execFile("ssh-keygen", ["-F", name, "-f", path], { timeout: 5_000 }, (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        if (!error.code) {
          reject(error);
          return;
        }
        resolve({ code: Number(error.code), stdout: String(stdout), stderr: String(stderr) });
      });
    });
    if (/Host .* found/.test(result.stdout)) return true;
  }
  return false;
}

/**
 * Collect the remote's host keys for user confirmation without trusting or
 * persisting them. BatchMode ssh under strict host key checking refuses before
 * OpenSSH prints any fingerprint, so the keys are scanned out of band instead.
 */
export async function proposeHostKeys(
  config: EffectiveSshConfig,
  signal?: AbortSignal,
): Promise<ProposedHostKeys> {
  const directory = mkdtempSync(join(tmpdir(), "pi-desktop-host-key-"));
  const knownHostsPath = join(directory, "known_hosts");
  writeFileSync(knownHostsPath, "", { mode: 0o600 });
  try {
    // ssh-keyscan reports DNS failures as an opaque "connection closed";
    // resolve the host through the system resolver first for a clear error.
    await lookup(config.hostname, { verbatim: true }).catch(() => {
      throw new SshError("SSH_RESOLVE_FAILED", `could not resolve hostname: ${config.hostname}`, "connecting");
    });
    const result = await run(openSshTool(process.platform === "win32" ? "ssh-keyscan.exe" : "ssh-keyscan"), [
      "-t", "rsa,ecdsa,ed25519,sk-ecdsa-sha2-nistp256@openssh.com,sk-ssh-ed25519@openssh.com",
      "-T", "10",
      "-p", String(config.port),
      config.hostname,
    ], { timeoutMs: 15_000, signal });
    const keys = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    if (!keys.length) {
      const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
      throw /could not resolve|not resolve|getaddrinfo|name or service not known|no address associated/.test(text)
        ? new SshError("SSH_RESOLVE_FAILED", result.stderr.trim() || `could not resolve ${config.hostname}`, "connecting", result.code)
        : /timed out/.test(text)
          ? new SshError("SSH_CONNECTION_TIMEOUT", result.stderr.trim() || "connection timed out", "connecting", result.code)
          : new SshError("SSH_HOST_KEY_FAILED", result.stderr.trim() || "the remote host did not present a host key", "connecting", result.code);
    }
    appendFileSync(knownHostsPath, `${keys.join("\n")}\n`, { mode: 0o600 });
    const fingerprintResult = await run("ssh-keygen", ["-lf", knownHostsPath], { timeoutMs: 5_000, signal });
    const fingerprints = [...new Set(fingerprintResult.stdout.match(/SHA256:[A-Za-z0-9+/=]+/g) ?? [])];
    if (!fingerprints.length) {
      throw new SshError("SSH_HOST_KEY_FAILED", "could not fingerprint the remote host keys", "connecting", result.code);
    }
    return {
      fingerprints,
      knownHostsPath,
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function confirmHostKeys(
  connection: RemoteConnection,
  proposed: ProposedHostKeys,
  password?: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const result = await run(resolveSshExecutable(), [
    ...commonArgs(connection, password),
    "-o", `UserKnownHostsFile=${proposed.knownHostsPath}`,
    "-o", "StrictHostKeyChecking=accept-new",
    "true",
  ], { timeoutMs: 15_000, password, signal });
  // An auth failure here is easy to mistake for a host-key problem now that
  // the scanned keys already satisfy StrictHostKeyChecking, so classify.
  if (result.code !== 0) {
    throw classify(result, "connecting");
  }
  const keys = readFileSync(proposed.knownHostsPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith("#"));
  const fingerprintResult = await run("ssh-keygen", ["-lf", proposed.knownHostsPath], { timeoutMs: 5_000 });
  const actual = new Set(fingerprintResult.stdout.match(/SHA256:[A-Za-z0-9+/=]+/g) ?? []);
  const proposedSet = new Set(proposed.fingerprints);
  try {
    if (!keys.length || ![...actual].every((fingerprint) => proposedSet.has(fingerprint))) {
      throw new SshError("SSH_HOST_KEY_FAILED", "the confirmed host key fingerprint changed", "connecting", result.code);
    }
    return keys;
  } finally {
    rmSync(dirname(proposed.knownHostsPath), { recursive: true, force: true });
  }
}

export function discardProposedHostKeys(proposed: ProposedHostKeys): void {
  rmSync(dirname(proposed.knownHostsPath), { recursive: true, force: true });
}

export async function acceptHostKeys(config: EffectiveSshConfig, keys: string[]): Promise<void> {
  const path = knownHostsPath();
  mkdirSync(dirname(path), { recursive: true });
  for (const name of hostKeyNames(config)) {
    await run("ssh-keygen", ["-R", name, "-f", path], { timeoutMs: 5_000 }).catch(() => undefined);
  }
  appendFileSync(path, `${keys.join("\n")}\n`, { mode: 0o600 });
}

export async function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("could not allocate a local port"))));
    });
  });
}

export type SshTunnel = {
  process: ChildProcess;
  localPort: number;
  exit: Promise<SshExecutionResult>;
};

export async function startSshTunnel(
  connection: RemoteConnection,
  remotePort: number,
  localPort: number,
  password?: string,
): Promise<SshTunnel> {
  const askpass = password === undefined ? undefined : await askpassContext(password);
  const child = spawn(resolveSshExecutable(), [
    "-N",
    "-T",
    ...authenticationArgs(connection, password),
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "ExitOnForwardFailure=yes",
    "-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    ...baseArgs(connection),
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    ...(askpass ? { env: { ...process.env, ...askpass.env } } : {}),
  });
  const exit = new Promise<SshExecutionResult>((resolve) => {
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(0, 512 * 1024);
    });
    child.once("error", (error) => resolve({ code: 1, stdout: "", stderr: error.message }));
    child.once("close", (code, signal) => resolve({
      code: signal ? 124 : code ?? 1,
      stdout: "",
      stderr: signal ? `${stderr}\nconnection timed out`.trim() : stderr,
    }));
  });
  void exit.then(() => askpass?.cleanup()).catch(() => askpass?.cleanup());
  return { process: child, localPort, exit };
}

export function disposeTunnel(tunnel: SshTunnel): void {
  if (tunnel.process.exitCode === null && !tunnel.process.killed) tunnel.process.kill("SIGTERM");
}
