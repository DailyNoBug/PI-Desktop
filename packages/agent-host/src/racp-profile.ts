import type {
  FsEntry,
  FsReadResult,
  McpServerRecord,
  McpServerStatus,
  RacpProjectSummary,
  RacpSession,
  RemoteDirectoryResult,
  WorkspaceDiff,
  UserSkillRecord,
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
  risk?: "low" | "medium" | "high";
  planSafeActions?: string[];
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
  listSkills(params: Record<string, unknown>): Promise<{ skills: UserSkillRecord[] }>;
  createSkill(params: Record<string, unknown>): Promise<{ skill: UserSkillRecord }>;
  updateSkill(params: Record<string, unknown>): Promise<{ skill: UserSkillRecord }>;
  readSkill(params: Record<string, unknown>): Promise<{ skill: UserSkillRecord | null; body: string | null }>;
  removeSkill(params: Record<string, unknown>): Promise<{ ok?: boolean }>;
  setSkillEnabled(params: Record<string, unknown>): Promise<{ skill: UserSkillRecord }>;
  setSkillScope(params: Record<string, unknown>): Promise<{ skill: UserSkillRecord }>;
  saveRevision(params: Record<string, unknown>): Promise<{ revision: unknown }>;
  listRevisions(params: Record<string, unknown>): Promise<{ revisions: unknown[] }>;
  activateRevision(params: Record<string, unknown>): Promise<{ messages: unknown[] }>;
  advertiseTools?(tools: RacpRelayTool[]): Promise<{ accepted: RacpRelayTool[]; rejected: Array<{ name: string; reason: string }> }>;
  openTerminal?(params: Record<string, unknown>): Promise<RacpTerminalSnapshot>;
  writeTerminal?(params: Record<string, unknown>): Promise<void>;
  resizeTerminal?(params: Record<string, unknown>): Promise<void>;
  closeTerminal?(params: Record<string, unknown>): Promise<void>;
}
