/**
 * Structured Git plugin API contracts (fork: `git.*` host surface). Consumed
 * by git-service.ts, the plugin-sdk surface, and pi-host's git tool bridge.
 */
import type { DiffFile } from "./workpanel.js";

export type GitChangeScope = "staged" | "unstaged" | "untracked";

export type GitFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflicted";

export type GitFileChange = {
  path: string;
  oldPath?: string;
  status: GitFileStatus;
  /** Set for an untracked directory reported as one aggregate entry. */
  directory?: boolean;
  additions: number;
  deletions: number;
  binary?: boolean;
  tooLarge?: boolean;
};

export type GitBranchInfo = {
  name: string;
  isCurrent: boolean;
};

export type GitStatus = {
  repo: boolean;
  detached?: boolean;
  initialBranch?: boolean;
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  conflicts: GitFileChange[];
  truncated?: boolean;
};

export type GitBranchesResult = {
  repo: boolean;
  branches: GitBranchInfo[];
  currentBranch?: string;
};

export type GitDiffResult = {
  scope: GitChangeScope;
  file: DiffFile | null;
};

export type GitOperationResult = {
  ok: true;
  status: GitStatus;
  commitHash?: string;
};
