import { spawn, execFile } from "node:child_process";
import { existsSync, appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createServer } from "node:net";
import type { ChildProcess } from "node:child_process";
import type { RemoteConnection } from "@pi-desktop/shared";

const SSH_TIMEOUT_MS = 15_000;

export type SshExecutionResult = { code: number; stdout: string; stderr: string };
export type EffectiveSshConfig = { hostname: string; user?: string; port: number; identityFile?: string };

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

export function resolveSshExecutable(): string {
  const explicit = process.env.PI_DESKTOP_SSH_BIN;
  if (explicit && existsSync(explicit)) return explicit;
  const name = process.platform === "win32" ? "ssh.exe" : "ssh";
  for (const directory of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new SshError("SSH_NOT_AVAILABLE", "system OpenSSH executable not found", "resolving");
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
    return [connection.sshConfigAlias];
  }
  const args: string[] = [];
  if (connection.port) args.push("-p", String(connection.port));
  if (connection.user) args.push("-l", connection.user);
  if (connection.identityFilePath) args.push("-i", connection.identityFilePath);
  args.push(connection.hostname ?? connection.displayName);
  return args;
}

function commonArgs(connection: RemoteConnection): string[] {
  return [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    ...baseArgs(connection),
  ];
}

function run(
  command: string,
  args: string[],
  options: { stdin?: string; timeoutMs?: number } = {},
): Promise<SshExecutionResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
    }, options.timeoutMs ?? SSH_TIMEOUT_MS);
    const finish = (result: SshExecutionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun(result);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
    child.on("close", (code, signal) => {
      if (signal) {
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

export async function effectiveSshConfig(connection: RemoteConnection): Promise<EffectiveSshConfig> {
  const config = configFile();
  const args = existsSync(config)
    ? ["-G", "-F", config, connection.sshConfigAlias ?? connection.hostname ?? ""]
    : ["-G", connection.sshConfigAlias ?? connection.hostname ?? ""];
  const result = await run(resolveSshExecutable(), args, { timeoutMs: 5_000 });
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
    ...(values.get("user") ? { user: values.get("user") } : {}),
    port,
    ...(values.get("identityfile") ? { identityFile: values.get("identityfile")!.replace(/^"|"$/g, "") } : {}),
  };
}

export async function sshProbe(connection: RemoteConnection): Promise<{ os: string; arch: string; home: string; shell: string }> {
  const result = await run(resolveSshExecutable(), [
    ...commonArgs(connection),
    "printf 'PI_HOST_PROBE_OS=%s\\nARCH=%s\\nHOME=%s\\nSHELL=%s\\n' \"$(uname -s)\" \"$(uname -m)\" \"$HOME\" \"$SHELL\"",
  ]);
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
): Promise<SshExecutionResult> {
  const envArgs = Object.entries(environment).map(([key, value]) => `${key}=${value}`);
  const result = await run(resolveSshExecutable(), [...commonArgs(connection), "env", ...envArgs, "sh", "-s"], {
    stdin: script,
    timeoutMs: 120_000,
  });
  if (result.code !== 0) throw classify(result, "bootstrapping");
  return result;
}

export async function readRemoteRuntimeMetadata(connection: RemoteConnection): Promise<Record<string, unknown> | null> {
  const result = await run(resolveSshExecutable(), [
    ...commonArgs(connection),
    `sh -c 'METADATA="$HOME/.pi-desktop/host/runtime/host.json"; [ -f "$METADATA" ] || exit 1; PID=$(tr "," "\n" < "$METADATA" | grep ".pid." | tr -cd "0-9"); [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null || exit 1; cat "$METADATA"'`,
  ]);
  if (result.code !== 0) throw classify(result, "connecting");
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
        if (error && !(error as { code?: number }).code) reject(error);
        else resolve({ code: (error as { code?: number }).code ?? 0, stdout: String(stdout), stderr: String(stderr) });
      });
    });
    if (/Host .* found/.test(result.stdout)) return true;
  }
  return false;
}

export async function scanHostKeys(config: EffectiveSshConfig): Promise<{ keys: string[]; fingerprints: string[] }> {
  const result = await run("ssh-keyscan", ["-T", "5", "-p", String(config.port), config.hostname], { timeoutMs: 10_000 });
  const keys = result.stdout.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith("#"));
  if (result.code !== 0 || keys.length === 0) {
    throw new SshError("SSH_HOST_KEY_FAILED", "could not obtain the remote host key", "connecting", result.code);
  }
  const fingerprintResult = await run("ssh-keygen", ["-lf", "-"], { stdin: `${keys.join("\n")}\n`, timeoutMs: 5_000 });
  if (fingerprintResult.code !== 0) {
    throw new SshError("SSH_HOST_KEY_FAILED", "could not fingerprint the remote host key", "connecting", fingerprintResult.code);
  }
  return {
    keys,
    fingerprints: fingerprintResult.stdout.split(/\r?\n/).filter((line) => line.trim()),
  };
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
): Promise<SshTunnel> {
  const child = spawn(resolveSshExecutable(), [
    "-N",
    "-T",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "ExitOnForwardFailure=yes",
    "-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    ...baseArgs(connection),
  ], { stdio: ["ignore", "pipe", "pipe"] });
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
  return { process: child, localPort, exit };
}

export function disposeTunnel(tunnel: SshTunnel): void {
  if (tunnel.process.exitCode === null && !tunnel.process.killed) tunnel.process.kill("SIGTERM");
}
