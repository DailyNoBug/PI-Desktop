/**
 * Remote SSH client contracts. Electron Main owns these records; the renderer
 * receives only non-secret views and invokes the typed IPC surface.
 */

export const REMOTE_CONNECTION_STATES = [
  "disconnected",
  "resolving",
  "connecting",
  "authenticating",
  "bootstrapping",
  "starting_host",
  "forwarding",
  "handshaking",
  "connected",
  "reconnecting",
  "incompatible",
  "error",
] as const;
export type RemoteConnectionState = (typeof REMOTE_CONNECTION_STATES)[number];

export type RemoteConnectionSource = "ssh-config" | "managed";
export type RemoteConnectionAuthMethod = "agent" | "password" | "identity";

export type RemoteConnectionInput = {
  displayName: string;
  source: RemoteConnectionSource;
  sshConfigAlias?: string;
  hostname?: string;
  user?: string;
  port?: number;
  authMethod?: RemoteConnectionAuthMethod;
  identityFilePath?: string;
  /** Write-only input. Durable connection records never retain this value. */
  password?: string;
  enabled: boolean;
};

export type RemoteConnection = Omit<RemoteConnectionInput, "password"> & {
  id: string;
  /** Explicitly selected workspace-free local tools relayed to this Host. */
  relayTools?: string[];
  createdAt: string;
  updatedAt: string;
};

export type RemoteHostRuntime = {
  id: string;
  connectionId: string;
  platform?: "linux";
  arch?: "x64" | "arm64";
  hostVersion?: string;
  protocolVersion?: number;
  storageSchemaVersion?: number;
  racpVersion?: string;
  lastConnectedAt?: string;
};

export type RemoteProjectRecord = {
  id: string;
  hostId: string;
  connectionId: string;
  name: string;
  remotePath: string;
  normalizedRemotePath: string;
  archived: boolean;
  lastOpenedAt?: string;
};

export type RemoteConnectionView = RemoteConnection & {
  state: RemoteConnectionState;
  host?: RemoteHostRuntime;
  lastError?: {
    code: string;
    message: string;
    stage?: RemoteConnectionState;
    at: string;
  };
  lastExitCode?: number | null;
  reconnectAttempt?: number;
};

export type RemoteRelayToolDescriptor = {
  name: string;
  description: string;
  parameters?: unknown;
  source: string;
  risk?: "low" | "medium" | "high";
  planSafeActions?: string[];
};

export type RemoteDirectoryEntry = {
  name: string;
  kind: "dir" | "file";
  size: number;
};

export type RemoteDirectoryResult = {
  path: string;
  homePath: string;
  entries: RemoteDirectoryEntry[];
  isGitRepository: boolean;
  readable: boolean;
};

export type RemoteTerminalSnapshot = {
  terminalId: string;
  replay: string;
};

export type RemoteTerminalEvent =
  | {
      kind: "output";
      sessionId: string;
      terminalId: string;
      data: string;
    }
  | {
      kind: "changed";
      sessionId: string;
      terminalId: string;
      status: "open" | "exit";
      exitCode?: number;
    };

export type RemoteDiagnostics = {
  desktopVersion: string;
  racpVersion: string;
  localPlatform: string;
  localArch: string;
  sshExecutable?: string;
  sshAlias?: string;
  remotePlatform?: string;
  remoteArch?: string;
  remoteHostVersion?: string;
  connectionStage: RemoteConnectionState;
  lastErrorCode?: string;
  lastExitCode?: number | null;
  portForwardState: "inactive" | "active" | "failed";
  handshakeState: "inactive" | "initialized" | "failed";
  remoteProjectPath?: string;
  sanitized: true;
};

export const REMOTE_RECONNECT_DELAYS_MS = [0, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;

function prereleaseIdentifierCompare(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    const difference = Number(left) - Number(right);
    return difference < 0 ? -1 : difference > 0 ? 1 : 0;
  }
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function prereleaseCompare(left: string[], right: string[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const result = prereleaseIdentifierCompare(a, b);
    if (result !== 0) return result;
  }
  return 0;
}

/** Compare Desktop/Host application versions without downgrading a newer Host. */
export function compareApplicationVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const match = value.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
    if (!match) return null;
    return {
      core: match.slice(1, 4).map(Number),
      prerelease: match[4]?.split(".").filter(Boolean) ?? [],
    };
  };
  const a = parse(left);
  const b = parse(right);
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index]! !== b.core[index]!) return a.core[index]! < b.core[index]! ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length !== 0) return 1;
  if (a.prerelease.length !== 0 && b.prerelease.length === 0) return -1;
  return prereleaseCompare(a.prerelease, b.prerelease);
}

const POSIX_ABSOLUTE_PATH = /^\/(?:[^/\0]+\/?)*$/;
const CONNECTION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function normalizeRemotePath(path: string): string | null {
  const value = path.trim();
  if (!POSIX_ABSOLUTE_PATH.test(value) || value.includes("\0")) return null;
  if (value.split("/").some((segment) => segment === "." || segment === "..")) return null;
  if (value === "/") return "/";
  return value.replace(/\/+$/, "");
}

export function remoteProjectUri(input: { connectionKey: string; remotePath: string }): string | null {
  const key = input.connectionKey.trim();
  const path = normalizeRemotePath(input.remotePath);
  if (!key || !path || /[/\s?#]/.test(key)) return null;
  return `ssh://${key}${path}`;
}

export function parseRemoteProjectUri(uri: string): { connectionKey: string; remotePath: string } | null {
  if (!uri.startsWith("ssh://")) return null;
  const rest = uri.slice("ssh://".length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const connectionKey = rest.slice(0, slash);
  const remotePath = normalizeRemotePath(rest.slice(slash));
  if (!remotePath || /[/\s?#]/.test(connectionKey)) return null;
  return { connectionKey, remotePath };
}

export function isRemoteProjectPath(path: string | null | undefined): path is string {
  return typeof path === "string" && parseRemoteProjectUri(path) !== null;
}

export function validateRemoteConnectionInput(
  input: Partial<RemoteConnectionInput> | undefined,
): { ok: true; value: RemoteConnectionInput } | { ok: false; error: string } {
  const displayName = input?.displayName?.trim() ?? "";
  if (!displayName || displayName.length > 80) {
    return { ok: false, error: "displayName must contain 1-80 characters" };
  }
  const source = input?.source;
  if (source !== "ssh-config" && source !== "managed") {
    return { ok: false, error: "source must be ssh-config or managed" };
  }
  const alias = input?.sshConfigAlias?.trim();
  const hostname = input?.hostname?.trim();
  if (source === "ssh-config" && !alias) {
    return { ok: false, error: "sshConfigAlias is required for an OpenSSH connection" };
  }
  if (source === "managed" && !hostname) {
    return { ok: false, error: "hostname is required for a managed connection" };
  }
  if ((alias && /[\s]/.test(alias)) || (hostname && /[\s]/.test(hostname))) {
    return { ok: false, error: "connection names cannot contain spaces" };
  }
  const port = input?.port;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    return { ok: false, error: "port must be an integer from 1 to 65535" };
  }
  const authMethod = input?.authMethod ??
    (source === "managed" && input?.identityFilePath?.trim() ? "identity" : "agent");
  if (authMethod !== "agent" && authMethod !== "password" && authMethod !== "identity") {
    return { ok: false, error: "authMethod must be agent, password, or identity" };
  }
  if (source !== "managed" && authMethod !== "agent") {
    return { ok: false, error: "explicit SSH authentication methods require a managed connection" };
  }
  const identityFilePath = input?.identityFilePath?.trim();
  if (authMethod === "identity" && !identityFilePath) {
    return { ok: false, error: "identityFilePath is required for identity authentication" };
  }
  if (authMethod !== "identity" && identityFilePath) {
    return { ok: false, error: "identityFilePath is only valid for identity authentication" };
  }
  const password = input?.password;
  if (password !== undefined && password.length > 8192) {
    return { ok: false, error: "password must contain at most 8192 characters" };
  }
  if (password && authMethod !== "password") {
    return { ok: false, error: "password is only valid for password authentication" };
  }
  return {
    ok: true,
    value: {
      displayName,
      source,
      ...(alias ? { sshConfigAlias: alias } : {}),
      ...(hostname ? { hostname } : {}),
      ...(input?.user?.trim() ? { user: input.user.trim() } : {}),
      ...(port !== undefined ? { port } : {}),
      ...(authMethod ? { authMethod } : {}),
      ...(identityFilePath ? { identityFilePath } : {}),
      ...(password ? { password } : {}),
      enabled: input?.enabled !== false,
    },
  };
}

export function isValidRemoteId(id: string): boolean {
  return CONNECTION_ID.test(id) && id.length <= 128;
}

export function sanitizeRemoteDiagnostics(value: RemoteDiagnostics): RemoteDiagnostics {
  return {
    ...value,
    sshAlias: value.sshAlias ? "configured" : undefined,
    remoteProjectPath: value.remoteProjectPath ? "configured" : undefined,
    sanitized: true,
  };
}
