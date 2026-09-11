import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type {
  GitBranchesResult,
  GitBranchInfo,
  GitChangeScope,
  GitDiffResult,
  GitFileChange,
  GitFileStatus,
  GitOperationResult,
  GitStatus,
} from "@pi-desktop/shared";
import { MAX_PATCH_BYTES, parseFilePatch, runGit, splitUnifiedDiff } from "./git-diff";

const MAX_STATUS_FILES = 1000;
const LOCAL_TIMEOUT_MS = 30_000;
const REMOTE_TIMEOUT_MS = 180_000;
const MAX_COMMIT_MESSAGE_CHARS = 8192;
const MAX_ERROR_CHARS = 2000;

type RunResult = { code: number; stdout: string; stderr: string; truncated?: boolean };

type RawStatusEntry = {
  path: string;
  oldPath?: string;
  index: string;
  worktree: string;
  untracked: boolean;
  unmerged: boolean;
};

type RawGitStatus = {
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  detached?: boolean;
  initialBranch?: boolean;
  entries: RawStatusEntry[];
};

export class GitServiceError extends Error {
  readonly errorCode: string;

  constructor(
    errorCode: string,
    message: string,
  ) {
    super(message);
    this.errorCode = errorCode;
  }
}

function unquoteGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  try {
    return JSON.parse(value) as string;
  } catch {
    return value.slice(1, -1);
  }
}

function validRelativePath(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const path = raw.replace(/\\/g, "/");
  if (path.includes("\0") || isAbsolute(path) || path.includes(":")) return null;
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return path;
}

function statusFromCode(code: string, oldPath?: string): GitFileStatus {
  if (code === "A") return "added";
  if (code === "D") return "deleted";
  if (code === "R" || (code === "C" && oldPath)) return "renamed";
  if (code === "?") return "untracked";
  if (code === "U") return "conflicted";
  return "modified";
}

function parseAheadBehind(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Parse porcelain v2 with `-z`; the caller supplies exactly that Git format. */
export function parseGitStatusV2(raw: string): RawGitStatus {
  const records = raw.split("\0");
  const result: RawGitStatus = { entries: [] };

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;

    if (record.startsWith("# branch.head ")) {
      const branch = record.slice("# branch.head ".length).trim();
      result.detached = branch === "(detached)";
      result.branch = result.detached ? undefined : branch;
      continue;
    }
    if (record === "# branch.oid (initial)") {
      result.initialBranch = true;
      continue;
    }
    if (record.startsWith("# branch.upstream ")) {
      result.upstream = record.slice("# branch.upstream ".length).trim() || undefined;
      continue;
    }
    if (record.startsWith("# branch.ab ")) {
      const match = record.match(/^# branch\.ab \+(\d+) -(\d+)$/);
      if (match) {
        result.ahead = parseAheadBehind(match[1]);
        result.behind = parseAheadBehind(match[2]);
      }
      continue;
    }

    const fields = record.split(" ");
    const kind = fields[0];
    if (kind === "?") {
      const path = unquoteGitPath(record.slice(2));
      result.entries.push({
        path,
        index: "?",
        worktree: "?",
        untracked: true,
        unmerged: false,
      });
      continue;
    }
    if (kind !== "1" && kind !== "2" && kind !== "u") continue;

    const xy = fields[1] ?? "..";
    const pathFieldIndex = kind === "u" ? 10 : 8;
    const rawPath = fields.slice(pathFieldIndex).join(" ");
    const path = unquoteGitPath(
      kind === "2" ? rawPath.replace(/^[RC]\d+ /, "") : rawPath,
    );
    const entry: RawStatusEntry = {
      path,
      index: xy[0] ?? ".",
      worktree: xy[1] ?? ".",
      untracked: false,
      unmerged: kind === "u" || xy.includes("U") || (xy[0] !== "." && xy[0] === xy[1]),
    };
    if (kind === "2") {
      const oldPath = records[index + 1];
      index += 1;
      if (oldPath) entry.oldPath = unquoteGitPath(oldPath);
    }
    result.entries.push(entry);
  }

  return result;
}

function parseNumstat(raw: string): Map<string, { additions: number; deletions: number; binary?: boolean }> {
  const counts = new Map<string, { additions: number; deletions: number; binary?: boolean }>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const fields = line.split("\t");
    if (fields.length < 3) continue;
    const additions = fields[0];
    const deletions = fields[1];
    const path = normalizeNumstatPath(unquoteGitPath(fields[2]));
    counts.set(path, {
      additions: additions === "-" ? 0 : Number.parseInt(additions, 10) || 0,
      deletions: deletions === "-" ? 0 : Number.parseInt(deletions, 10) || 0,
      binary: additions === "-" || deletions === "-",
    });
  }
  return counts;
}

function normalizeNumstatPath(path: string): string {
  if (!path.includes("=>")) return path;
  const direct = path.match(/^(.*?)\s*=>\s*(.*)$/);
  if (direct && !direct[1].includes("{") && !direct[2].includes("}")) {
    return direct[2];
  }
  const compact = path.match(/^(.*)\{(.*)\}(.*)$/);
  if (compact) {
    return `${compact[1]}${compact[2].split("=>").pop()?.trim()}${compact[3]}`;
  }
  return path;
}

function safeInsideRoot(root: string, path: string): string {
  const full = resolve(root, path);
  const normalizedRoot = resolve(root);
  if (full !== normalizedRoot && !full.startsWith(normalizedRoot + sep)) {
    throw new GitServiceError("GIT_PATH_DENIED", "path escapes the workspace");
  }
  return full;
}

function validBranchName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (
    !name ||
    name.length > 200 ||
    name.startsWith("-") ||
    name === "@" ||
    name.includes("..") ||
    name.includes("@{") ||
    /[\s~^:?*[\]\\]/.test(name) ||
    /[\u0000-\u001f\u007f]/.test(name) ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.includes("//") ||
    name
      .split("/")
      .some((segment) => segment.startsWith(".") || segment.endsWith(".") || segment.endsWith(".lock"))
  ) {
    return null;
  }
  return name;
}

function gitErrorCode(stderr: string): string {
  const message = stderr.toLowerCase();
  if (
    message.includes("authentication failed") ||
    message.includes("could not read username") ||
    message.includes("permission denied (publickey") ||
    message.includes("permission denied (keyboard-interactive")
  ) {
    return "GIT_AUTH_FAILED";
  }
  if (/\b(pre-commit|prepare-commit-msg|commit-msg|post-commit)\b/.test(stderr)) {
    return "GIT_HOOK_FAILED";
  }
  if (
    message.includes("would be overwritten by merge") ||
    message.includes("would be overwritten by checkout") ||
    message.includes("please commit your changes") ||
    message.includes("conflict")
  ) {
    return "GIT_CONFLICT";
  }
  if (message.includes("no configured push default") || message.includes("has no upstream")) {
    return "GIT_NO_UPSTREAM";
  }
  return "GIT_FAILED";
}

function sanitizeGitMessage(message: string): string {
  return message
    .replace(/(https?:\/\/)([^:@/\s]+):([^@/\s]+)@/g, "$1<redacted>@")
    .replace(/(ssh:\/\/)([^:@/\s]+):([^@/\s]+)@/g, "$1<redacted>@")
    .split("\n")
    .map((line) => line.slice(0, 240))
    .join("\n")
    .slice(0, MAX_ERROR_CHARS)
    .trim();
}

function emptyStatus(): GitStatus {
  return { repo: false, staged: [], unstaged: [], conflicts: [] };
}

export class GitService {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly deps: {
    getWorkspacePath: () => string | null;
    trashItem?: (fullPath: string) => Promise<void>;
  };

  constructor(
    deps: {
      getWorkspacePath: () => string | null;
      trashItem?: (fullPath: string) => Promise<void>;
    },
  ) {
    this.deps = deps;
  }

  async status(): Promise<GitStatus> {
    const cwd = this.workspace();
    return this.withLock(cwd, () => this.collectStatus(cwd));
  }

  async branches(): Promise<GitBranchesResult> {
    const cwd = this.workspace();
    return this.withLock(cwd, async () => {
      if (!(await this.isRepository(cwd))) return { repo: false, branches: [] };
      const result = await this.git(cwd, [
        "for-each-ref",
        "--format=%(refname:short)%09%(HEAD)",
        "refs/heads",
      ]);
      const branches: GitBranchInfo[] = result.stdout
        .split("\n")
        .filter(Boolean)
        .map((record) => {
          const separator = record.lastIndexOf("\t");
          const name = separator >= 0 ? record.slice(0, separator) : record;
          const marker = separator >= 0 ? record.slice(separator + 1) : "";
          return { name, isCurrent: marker === "*" };
        })
        .filter((branch) => branch.name);
      branches.sort((a, b) => a.name.localeCompare(b.name));
      return {
        repo: true,
        branches,
        currentBranch: branches.find((branch) => branch.isCurrent)?.name,
      };
    });
  }

  async diff(input: { path?: unknown; scope?: unknown }): Promise<GitDiffResult> {
    const path = validRelativePath(input.path);
    const scope = input.scope;
    if (!path) throw new GitServiceError("GIT_PATH_DENIED", "a valid workspace-relative path is required");
    if (scope !== "staged" && scope !== "unstaged" && scope !== "untracked") {
      throw new GitServiceError("INVALID_ARGUMENT", "diff scope must be staged, unstaged, or untracked");
    }
    const cwd = this.workspace();
    safeInsideRoot(cwd, path);
    return this.withLock(cwd, async () => {
      const args =
        scope === "untracked"
          ? ["diff", "--no-color", "--no-ext-diff", "--unified=3", "--no-index", "--", "/dev/null", path]
          : [
              "diff",
              ...(scope === "staged" ? ["--cached"] : []),
              "--no-color",
              "--no-ext-diff",
              "-M",
              "--unified=3",
              "--",
              path,
            ];
      const result = await this.git(cwd, args, undefined, scope === "untracked");
      const chunk = splitUnifiedDiff(result.stdout)[0];
      const file = chunk ? parseFilePatch(chunk, scope === "untracked" ? "untracked" : undefined) : null;
      return { scope, file } satisfies GitDiffResult;
    });
  }

  async stage(input: { paths?: unknown; all?: unknown }): Promise<GitOperationResult> {
    const paths = this.paths(input);
    return this.mutation(async cwd => {
      await this.git(cwd, [
        "add",
        "--all",
        ...(paths.length ? ["--", ...paths] : []),
      ]);
      return { ok: true as const, status: await this.collectStatus(cwd) };
    });
  }

  async unstage(input: { paths?: unknown; all?: unknown }): Promise<GitOperationResult> {
    const paths = this.paths(input);
    return this.mutation(async cwd => {
      const hasHead = (await this.git(cwd, ["rev-parse", "--verify", "HEAD"], undefined, false, true)).code === 0;
      await this.git(
        cwd,
        hasHead
          ? ["reset", ...(paths.length ? ["--", ...paths] : [])]
          : paths.length
            ? ["rm", "--cached", "--", ...paths]
            : ["rm", "--cached", "-r", "--", "."],
      );
      return { ok: true as const, status: await this.collectStatus(cwd) };
    });
  }

  async discard(input: { paths?: unknown; all?: unknown }): Promise<GitOperationResult> {
    if (input.all !== undefined) {
      throw new GitServiceError("INVALID_ARGUMENT", "discard requires explicit paths");
    }
    const requested = this.paths(input, true);
    return this.mutation(async cwd => {
      const status = await this.collectStatus(cwd);
      if (status.conflicts.length > 0) {
        throw new GitServiceError("GIT_CONFLICT", "resolve conflicts before discarding changes");
      }
      const byPath = new Map(
        [...status.staged, ...status.unstaged].map(change => [change.path, change]),
      );
      const selected: string[] = [];
      for (const path of requested) {
        const change = byPath.get(path);
        if (!change) {
          throw new GitServiceError("GIT_PATH_DENIED", "path is not currently changed");
        }
        selected.push(path);
        if (change.oldPath && !selected.includes(change.oldPath)) selected.push(change.oldPath);
      }
      const untracked: string[] = [];
      const tracked: string[] = [];

      const head = await this.git(cwd, ["rev-parse", "--verify", "HEAD"], undefined, false, true);
      if (head.code === 0) {
        for (const path of selected) {
          const existsInHead = await this.git(
            cwd,
            ["cat-file", "-e", `HEAD:${path}`],
            undefined,
            false,
            true,
          );
          if (existsInHead.code === 0) tracked.push(path);
          else untracked.push(path);
        }
        const stagedUntracked = untracked.filter(path => status.staged.some(change => change.path === path));
        if (stagedUntracked.length) {
          await this.git(cwd, ["reset", "--", ...stagedUntracked]);
        }
        if (tracked.length) {
          await this.git(cwd, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...tracked]);
        }
      } else {
        const stagedPaths = selected.filter(path => status.staged.some(change => change.path === path));
        if (stagedPaths.length) {
          await this.git(cwd, ["rm", "--cached", "--ignore-unmatch", "--", ...stagedPaths]);
        }
        untracked.push(...selected);
      }
      if (untracked.length) {
        if (!this.deps.trashItem) throw new GitServiceError("UNSUPPORTED", "workspace trash is unavailable");
        for (const path of untracked) {
          await this.deps.trashItem(safeInsideRoot(cwd, path));
        }
      }
      return { ok: true as const, status: await this.collectStatus(cwd) };
    });
  }

  async createBranch(input: { name?: unknown; checkout?: unknown }): Promise<GitOperationResult> {
    const name = validBranchName(input.name);
    if (!name) {
      throw new GitServiceError("INVALID_ARGUMENT", "invalid branch name");
    }
    const checkout = input.checkout === true;
    return this.mutation(async cwd => {
      await this.git(cwd, checkout ? ["switch", "-c", name] : ["branch", name]);
      return { ok: true as const, status: await this.collectStatus(cwd) };
    });
  }

  async switchBranch(input: { branch?: unknown }): Promise<GitOperationResult> {
    const branch = validBranchName(input.branch);
    if (!branch) {
      throw new GitServiceError("INVALID_ARGUMENT", "invalid branch name");
    }
    return this.mutation(async cwd => {
      await this.git(cwd, ["switch", branch]);
      return { ok: true as const, status: await this.collectStatus(cwd) };
    });
  }

  async commit(input: { message?: unknown; stageAll?: unknown }): Promise<GitOperationResult> {
    const message = typeof input.message === "string" ? input.message.trim() : "";
    if (!message || message.length > MAX_COMMIT_MESSAGE_CHARS) {
      throw new GitServiceError("INVALID_ARGUMENT", "a bounded commit message is required");
    }
    return this.mutation(async cwd => {
      if (input.stageAll === true) await this.git(cwd, ["add", "--all"]);
      await this.git(cwd, ["commit", "-m", message]);
      const hash = await this.git(cwd, ["rev-parse", "--short", "HEAD"]);
      return {
        ok: true as const,
        status: await this.collectStatus(cwd),
        commitHash: hash.stdout.trim(),
      };
    });
  }

  async push(input: { publish?: unknown }): Promise<GitOperationResult> {
    return this.mutation(async cwd => {
      const status = await this.collectStatus(cwd);
      if (!status.branch) throw new GitServiceError("GIT_NO_BRANCH", "a named branch is required");
      await this.git(
        cwd,
        input.publish === true
          ? ["push", "--set-upstream", "origin", status.branch]
          : ["push"],
        REMOTE_TIMEOUT_MS,
      );
      return { ok: true as const, status: await this.collectStatus(cwd) };
    });
  }

  async pull(): Promise<GitOperationResult> {
    return this.mutation(async cwd => {
      await this.git(cwd, ["pull", "--ff-only"], REMOTE_TIMEOUT_MS);
      return { ok: true as const, status: await this.collectStatus(cwd) };
    });
  }

  private workspace(): string {
    const cwd = this.deps.getWorkspacePath();
    if (!cwd) throw new GitServiceError("NO_WORKSPACE", "open a project first");
    return cwd;
  }

  private paths(input: { paths?: unknown; all?: unknown }, requireExplicit = false): string[] {
    let hasPaths = false;
    if (Array.isArray(input.paths)) {
      hasPaths = true;
      const paths = input.paths.map(validRelativePath);
      if (paths.some(path => path === null)) {
        throw new GitServiceError("GIT_PATH_DENIED", "paths must stay inside the workspace");
      }
      const unique = [...new Set(paths as string[])];
      if (unique.length > MAX_STATUS_FILES) {
        throw new GitServiceError("INVALID_ARGUMENT", "too many paths selected");
      }
      if (unique.length) return unique;
    }
    if (input.all === true && !hasPaths && !requireExplicit) return [];
    throw new GitServiceError("INVALID_ARGUMENT", "choose either explicit paths or all");
  }

  private async mutation<T extends GitOperationResult>(
    operation: (cwd: string) => Promise<T>,
  ): Promise<T> {
    const cwd = this.workspace();
    return this.withLock(cwd, () => operation(cwd));
  }

  private async withLock<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(cwd) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.tails.set(
      cwd,
      next.then(() => undefined, () => undefined),
    );
    return next;
  }

  private async isRepository(cwd: string): Promise<boolean> {
    const probe = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], {
      timeoutMs: LOCAL_TIMEOUT_MS,
    });
    return probe.code === 0 && probe.stdout.trim() === "true";
  }

  private async collectStatus(cwd = this.workspace()): Promise<GitStatus> {
    if (!(await this.isRepository(cwd))) return emptyStatus();
    const status = await this.git(cwd, [
      "status",
      "--porcelain=v2",
      "--branch",
      "--untracked-files=all",
      "-z",
    ]);
    const parsed = parseGitStatusV2(status.stdout);
    const truncated = parsed.entries.length > MAX_STATUS_FILES;
    const entries = parsed.entries.slice(0, MAX_STATUS_FILES);
    const staged: GitFileChange[] = [];
    const unstaged: GitFileChange[] = [];
    const conflicts: GitFileChange[] = [];

    const [cachedNumstat, worktreeNumstat] = await Promise.all([
      this.git(cwd, ["diff", "--cached", "--numstat", "-M"]),
      this.git(cwd, ["diff", "--numstat", "-M"]),
    ]);
    const cachedCounts = parseNumstat(cachedNumstat.stdout);
    const worktreeCounts = parseNumstat(worktreeNumstat.stdout);

    for (const entry of entries) {
      if (!validRelativePath(entry.path)) continue;
      const conflict = entry.unmerged;
      const base = (scope: "staged" | "unstaged"): GitFileChange => ({
        path: entry.path,
        oldPath: scope === "staged" ? entry.oldPath : undefined,
        status: conflict
          ? "conflicted"
          : statusFromCode(
              scope === "staged" ? entry.index : entry.worktree,
              entry.oldPath,
            ),
        additions: 0,
        deletions: 0,
      });

      if (conflict) {
        conflicts.push(base("unstaged"));
        continue;
      }
      if (entry.index !== "." && entry.index !== "?") {
        const change = base("staged");
        const count = cachedCounts.get(entry.path);
        change.additions = count?.additions ?? 0;
        change.deletions = count?.deletions ?? 0;
        change.binary = count?.binary;
        staged.push(change);
      }
      if (entry.untracked || entry.worktree !== ".") {
        const change = base("unstaged");
        if (entry.untracked) {
          const count = await this.untrackedCounts(cwd, entry.path);
          change.additions = count.additions;
          change.deletions = count.deletions;
          change.binary = count?.binary;
          change.tooLarge = count.tooLarge;
        } else {
          const count = worktreeCounts.get(entry.path);
          change.additions = count?.additions ?? 0;
          change.deletions = count?.deletions ?? 0;
          change.binary = count?.binary;
        }
        unstaged.push(change);
      }
    }

    return {
      repo: true,
      detached: parsed.detached,
      initialBranch: parsed.initialBranch,
      branch: parsed.branch,
      upstream: parsed.upstream,
      ahead: parsed.ahead,
      behind: parsed.behind,
      staged,
      unstaged,
      conflicts,
      truncated: truncated || status.truncated || undefined,
    };
  }

  private async untrackedCounts(
    cwd: string,
    path: string,
  ): Promise<{ additions: number; deletions: number; binary?: boolean; tooLarge?: boolean }> {
    try {
      const full = safeInsideRoot(cwd, path);
      const info = await stat(full);
      if (!info.isFile()) return { additions: 0, deletions: 0 };
      if (info.size > MAX_PATCH_BYTES) {
        return { additions: 0, deletions: 0, tooLarge: true };
      }
      const content = await readFile(full);
      if (content.includes(0)) return { additions: 0, deletions: 0, binary: true };
      const text = content.toString("utf8");
      const lineText = text.replace(/\r?\n$/, "");
      return { additions: lineText ? lineText.split("\n").length : 0, deletions: 0 };
    } catch {
      return { additions: 0, deletions: 0 };
    }
  }

  private async git(
    cwd: string,
    args: string[],
    timeoutMs = LOCAL_TIMEOUT_MS,
    allowDifferenceExit = false,
    allowFailure = false,
  ): Promise<RunResult> {
    const result = await runGit(cwd, args, { timeoutMs });
    const expected = allowDifferenceExit && result.code === 1;
    if (result.code !== 0 && !expected && !allowFailure) {
      throw new GitServiceError(
        result.truncated ? "GIT_OUTPUT_TRUNCATED" : gitErrorCode(result.stderr || result.stdout),
        sanitizeGitMessage(result.stderr || result.stdout || `git ${args[0]} failed`),
      );
    }
    return result;
  }
}
