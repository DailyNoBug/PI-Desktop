import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type {
  RemoteConnection,
  RemoteConnectionInput,
  RemoteHostRuntime,
  RemoteProjectRecord,
} from "@pi-desktop/shared";
import { isValidRemoteId, validateRemoteConnectionInput } from "@pi-desktop/shared";

type StoreShape = {
  version: 1;
  connections: RemoteConnection[];
  hosts: RemoteHostRuntime[];
  projects: RemoteProjectRecord[];
};

const emptyStore: StoreShape = { version: 1, connections: [], hosts: [], projects: [] };

function now(): string {
  return new Date().toISOString();
}

function parseStore(raw: string): StoreShape {
  try {
    const value = JSON.parse(raw) as Partial<StoreShape>;
    if (value.version !== 1) return structuredClone(emptyStore);
    return {
      version: 1,
      connections: Array.isArray(value.connections) ? value.connections : [],
      hosts: Array.isArray(value.hosts) ? value.hosts : [],
      projects: Array.isArray(value.projects) ? value.projects : [],
    };
  } catch {
    return structuredClone(emptyStore);
  }
}

/** Non-secret durable records for SSH entries. Tokens stay in host-core secrets. */
export class RemoteStore {
  private shape: StoreShape;
  private readonly file: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, "remote-ssh.json");
    this.shape = existsSync(this.file) ? parseStore(readFileSync(this.file, "utf8")) : structuredClone(emptyStore);
    this.flush();
  }

  listConnections(): RemoteConnection[] {
    return [...this.shape.connections].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  getConnection(id: string): RemoteConnection | undefined {
    return this.shape.connections.find((connection) => connection.id === id);
  }

  upsertDiscoveredConnection(input: RemoteConnectionInput): RemoteConnection | undefined {
    const alias = input.sshConfigAlias?.trim();
    if (!alias) return undefined;
    const id = `ssh:${alias}`;
    const existing = this.getConnection(id);
    if (existing) return existing;
    const next: RemoteConnection = { ...input, id, createdAt: now(), updatedAt: now() };
    this.putConnection(next);
    return next;
  }

  addManagedConnection(input: RemoteConnectionInput): RemoteConnection {
    const validated = validateRemoteConnectionInput(input);
    if (!validated.ok) throw new Error(validated.error);
    const connection: RemoteConnection = {
      ...validated.value,
      id: `managed:${randomUUID()}`,
      createdAt: now(),
      updatedAt: now(),
    };
    this.putConnection(connection);
    return connection;
  }

  updateConnection(id: string, input: RemoteConnectionInput): RemoteConnection {
    const existing = this.getConnection(id);
    if (!existing) throw new Error("remote connection not found");
    const validated = validateRemoteConnectionInput(input);
    if (!validated.ok) throw new Error(validated.error);
    const next: RemoteConnection = { ...existing, ...validated.value, id, updatedAt: now() };
    this.putConnection(next);
    return next;
  }

  removeConnection(id: string): boolean {
    const existed = this.shape.connections.some((connection) => connection.id === id);
    this.shape.connections = this.shape.connections.filter((connection) => connection.id !== id);
    const hostIds = new Set(this.shape.hosts.filter((host) => host.connectionId === id).map((host) => host.id));
    this.shape.hosts = this.shape.hosts.filter((host) => host.connectionId !== id);
    this.shape.projects = this.shape.projects.filter((project) => !hostIds.has(project.hostId));
    this.flush();
    return existed;
  }

  listHosts(): RemoteHostRuntime[] {
    return [...this.shape.hosts];
  }

  getHost(id: string): RemoteHostRuntime | undefined {
    return this.shape.hosts.find((host) => host.id === id);
  }

  putHost(host: RemoteHostRuntime): void {
    if (!isValidRemoteId(host.id)) throw new Error("invalid remote host id");
    const index = this.shape.hosts.findIndex((candidate) => candidate.id === host.id);
    if (index === -1) this.shape.hosts.push(host);
    else this.shape.hosts[index] = { ...this.shape.hosts[index]!, ...host };
    this.flush();
  }

  listProjects(): RemoteProjectRecord[] {
    return [...this.shape.projects].sort((a, b) => a.name.localeCompare(b.name));
  }

  getProject(id: string): RemoteProjectRecord | undefined {
    return this.shape.projects.find((project) => project.id === id);
  }

  projectForPath(path: string): RemoteProjectRecord | undefined {
    return this.shape.projects.find((project) => project.normalizedRemotePath === path);
  }

  addProject(input: {
    hostId: string;
    connectionId: string;
    remotePath: string;
    name: string;
  }): RemoteProjectRecord {
    const normalized = input.remotePath.replace(/\/+$/, "") || "/";
    const id = `project:${createHash("sha256").update(`${input.hostId}:${normalized}`).digest("hex").slice(0, 20)}`;
    const existing = this.getProject(id);
    const record: RemoteProjectRecord = {
      id,
      hostId: input.hostId,
      connectionId: input.connectionId,
      name: input.name,
      remotePath: input.remotePath,
      normalizedRemotePath: normalized,
      archived: existing?.archived ?? false,
      lastOpenedAt: now(),
    };
    const index = this.shape.projects.findIndex((project) => project.id === id);
    if (index === -1) this.shape.projects.push(record);
    else this.shape.projects[index] = record;
    this.flush();
    return record;
  }

  removeProject(id: string): boolean {
    const before = this.shape.projects.length;
    this.shape.projects = this.shape.projects.filter((project) => project.id !== id);
    this.flush();
    return this.shape.projects.length !== before;
  }

  touchProject(id: string): void {
    const project = this.getProject(id);
    if (!project) return;
    project.lastOpenedAt = now();
    this.flush();
  }

  private putConnection(next: RemoteConnection): void {
    const index = this.shape.connections.findIndex((connection) => connection.id === next.id);
    if (index === -1) this.shape.connections.push(next);
    else this.shape.connections[index] = next;
    this.flush();
  }

  private flush(): void {
    writeFileSync(this.file, `${JSON.stringify(this.shape, null, 2)}\n`, { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }
}
