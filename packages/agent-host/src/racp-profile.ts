import type {
  FsEntry,
  FsReadResult,
  McpServerRecord,
  McpServerStatus,
  RacpProjectSummary,
  RacpSession,
  RemoteDirectoryResult,
  WorkspaceDiff,
} from "@pi-desktop/shared";

export type RacpTerminalSnapshot = {
  terminalId: string;
  /** PTY replay bytes encoded as base64 for the JSON binding. */
  replay: string;
};

export type RacpRelayTool = {
  name: string;
  description: string;
  parameters: unknown;
  source: string;
  requiresWorkspace: boolean;
};

/**
 * Remote-host operations that are intentionally outside turn admission:
 * durable session metadata, workspace views, relayed tools, and terminals.
 */
export interface RacpRemoteProfile {
  listProjects(): Promise<RacpProjectSummary[]>;
  listSessions(): Promise<RacpSession[]>;
  createSession(params: Record<string, unknown>): Promise<RacpSession>;
  configureSession(params: Record<string, unknown>): Promise<RacpSession>;
  forkSession(params: Record<string, unknown>): Promise<RacpSession>;
  renameSession(params: Record<string, unknown>): Promise<RacpSession>;
  deleteSession(params: Record<string, unknown>): Promise<void>;
  compactSession(params: Record<string, unknown>): Promise<{ accepted: boolean }>;
  browseWorkspace(params: Record<string, unknown>): Promise<RemoteDirectoryResult>;
  listWorkspace(params: Record<string, unknown>): Promise<{ entries: FsEntry[] }>;
  readWorkspace(params: Record<string, unknown>): Promise<FsReadResult>;
  diffWorkspace(params: Record<string, unknown>): Promise<WorkspaceDiff>;
  listMcp(params: Record<string, unknown>): Promise<{ servers: McpServerRecord[]; statuses: McpServerStatus[] }>;
  upsertMcp(params: Record<string, unknown>): Promise<{ server: McpServerRecord }>;
  removeMcp(params: Record<string, unknown>): Promise<{ ok?: boolean }>;
  setMcpEnabled(params: Record<string, unknown>): Promise<{ server: McpServerRecord }>;
  setMcpScope(params: Record<string, unknown>): Promise<{ server: McpServerRecord }>;
  testMcp(params: Record<string, unknown>): Promise<{ status: McpServerStatus }>;
  advertiseTools?(tools: RacpRelayTool[]): Promise<{ accepted: RacpRelayTool[]; rejected: Array<{ name: string; reason: string }> }>;
  openTerminal?(params: Record<string, unknown>): Promise<RacpTerminalSnapshot>;
  writeTerminal?(params: Record<string, unknown>): Promise<void>;
  resizeTerminal?(params: Record<string, unknown>): Promise<void>;
  closeTerminal?(params: Record<string, unknown>): Promise<void>;
}
