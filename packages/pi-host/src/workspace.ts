import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import type {
  DiffFile,
  DiffFileStatus,
  DiffHunk,
  FsEntry,
  FsReadResult,
  RemoteDirectoryEntry,
  RemoteDirectoryResult,
  WorkspaceDiff,
} from "@pi-desktop/shared";
import { normalizeRemotePath } from "@pi-desktop/shared";

const IGNORED_NAMES = new Set([
  ".git",
  "node_modules",
  ".DS_Store",
  "target",
  "dist",
  "build",
  "out",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
]);
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_DIFF_FILES = 100;
const MAX_PATCH_BYTES = 200 * 1024;
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  avif: "image/avif",
};

function inside(root: string, target: string): boolean {
  const value = relative(root, target);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !value.startsWith(sep));
}

async function realExistingPath(path: string): Promise<string | null> {
  try {
    return await realpath(resolve(path));
  } catch {
    return null;
  }
}

export async function browseRemotePath(inputPath: string | undefined, homePath: string): Promise<RemoteDirectoryResult> {
  const requested = normalizeRemotePath(inputPath ?? homePath) ?? homePath;
  const path = await realExistingPath(requested);
  if (!path) throw Object.assign(new Error(`remote path does not exist: ${requested}`), {
    errorCode: "REMOTE_PROJECT_NOT_FOUND",
  });
  const info = await stat(path);
  if (!info.isDirectory()) throw Object.assign(new Error("remote path is not a directory"), {
    errorCode: "REMOTE_PROJECT_INVALID_PATH",
  });
  const dirents = await readdir(path, { withFileTypes: true });
  const entries: RemoteDirectoryEntry[] = [];
  for (const dirent of dirents) {
    if (IGNORED_NAMES.has(dirent.name)) continue;
    const target = resolve(path, dirent.name);
    const real = await realExistingPath(target);
    if (!real) continue;
    const targetInfo = await stat(real).catch(() => null);
    if (!targetInfo?.isFile() && !targetInfo?.isDirectory()) continue;
    entries.push({
      name: dirent.name,
      kind: targetInfo.isDirectory() ? "dir" : "file",
      size: targetInfo.isFile() ? targetInfo.size : 0,
    });
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
  return {
    path,
    homePath,
    entries,
    isGitRepository: existsSync(resolve(path, ".git")),
    readable: true,
  };
}

export async function listSessionWorkspace(root: string, relativePath: string | undefined): Promise<FsEntry[]> {
  const target = await resolveSessionPath(root, relativePath ?? "");
  if (!target) throw pathError();
  const rootReal = await realExistingPath(root);
  const dirents = await readdir(target, { withFileTypes: true });
  const entries: FsEntry[] = [];
  for (const dirent of dirents) {
    if (IGNORED_NAMES.has(dirent.name)) continue;
    const candidate = resolve(target, dirent.name);
    const real = await realExistingPath(candidate);
    if (!real || !rootReal || !inside(rootReal, real)) continue;
    const info = await stat(real).catch(() => null);
    if (!info?.isFile() && !info?.isDirectory()) continue;
    entries.push({
      name: dirent.name,
      kind: info.isDirectory() ? "dir" : "file",
      size: info.isFile() ? info.size : 0,
    });
  }
  return entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
}

export async function readSessionWorkspace(root: string, relativePath: string): Promise<FsReadResult> {
  const target = await resolveSessionPath(root, relativePath);
  if (!target) throw pathError();
  const info = await stat(target);
  if (!info.isFile()) {
    return { kind: info.isDirectory() ? "binary" : "tooLarge", size: info.size };
  }
  const ext = target.split(".").pop()?.toLowerCase() ?? "";
  const isImage = Boolean(IMAGE_MIME[ext]);
  if (isImage && info.size <= MAX_IMAGE_BYTES) {
    return {
      kind: "image",
      dataUrl: `data:${IMAGE_MIME[ext]};base64,${(await readFile(target)).toString("base64")}`,
      size: info.size,
    };
  }
  const bytes = await readFile(target);
  if (info.size > MAX_TEXT_BYTES || looksBinary(bytes)) {
    return { kind: "binary", size: info.size };
  }
  return { kind: "text", content: bytes.toString("utf8"), size: info.size };
}

async function resolveSessionPath(root: string, relativePath: string): Promise<string | null> {
  const rootReal = await realExistingPath(root);
  if (!rootReal) return null;
  const clean = String(relativePath ?? "").replace(/^[/\\]+/, "");
  if (clean.split(/[/\\]/).some((part) => part === "..")) return null;
  const target = await realExistingPath(resolve(rootReal, clean));
  return target && inside(rootReal, target) ? target : null;
}

function pathError(): Error & { errorCode: string } {
  return Object.assign(new Error("path escapes the session workspace"), {
    errorCode: "PATH_OUTSIDE_WORKSPACE",
  });
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 8000)).includes(0);
}

function runGit(cwd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolveRun) => {
    const child = spawn("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + String(chunk)).slice(0, 4 * 1024 * 1024);
    });
    child.on("error", () => resolveRun({ code: 1, stdout }));
    child.on("close", (code) => resolveRun({ code: code ?? 1, stdout }));
  });
}

type StatusEntry = { path: string; oldPath?: string; untracked: boolean };

function parseStatusZ(raw: string): StatusEntry[] {
  const records = raw.split("\0").filter(Boolean);
  const out: StatusEntry[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record.length < 4) continue;
    const xy = record.slice(0, 2);
    const path = record.slice(3);
    if (xy === "!!") continue;
    if (xy.includes("R") || xy.includes("C")) {
      out.push({ path, oldPath: records[i + 1], untracked: false });
      i += 1;
    } else {
      out.push({ path, untracked: xy === "??" });
    }
  }
  return out;
}

function splitUnifiedDiff(raw: string): string[] {
  const lines = raw.split("\n");
  const chunks: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current) chunks.push(current);
      current = [line];
    } else if (current) current.push(line);
  }
  if (current) chunks.push(current);
  return chunks.map((chunk) => chunk.join("\n"));
}

function stripPath(path: string): string {
  return path.replace(/^[ab]\//, "");
}

function parseFilePatch(chunk: string, statusHint?: DiffFileStatus): DiffFile | null {
  const lines = chunk.split("\n");
  if (!lines[0]?.startsWith("diff --git ")) return null;
  let path = "";
  let oldPath: string | undefined;
  let status: DiffFileStatus = statusHint ?? "modified";
  let binary = false;
  let additions = 0;
  let deletions = 0;
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  for (const line of lines) {
    if (line.startsWith("--- ")) {
      const value = stripPath(line.slice(4).trim());
      if (value !== "/dev/null") oldPath = value;
    } else if (line.startsWith("+++ ")) {
      path = stripPath(line.slice(4).trim());
    } else if (line.startsWith("new file mode") && !statusHint) status = "added";
    else if (line.startsWith("deleted file mode")) status = "deleted";
    else if (line.startsWith("rename from ")) oldPath = line.slice("rename from ".length).trim();
    else if (line.startsWith("rename to ")) {
      path = line.slice("rename to ".length).trim();
      status = "renamed";
    } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) binary = true;
    else if (line.startsWith("@@")) {
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      current = {
        header: line,
        oldStart: match ? Number(match[1]) : undefined,
        newStart: match ? Number(match[2]) : undefined,
        lines: [],
      };
      hunks.push(current);
    } else if (!current) continue;
    else if (line.startsWith("+")) {
      additions += 1;
      current.lines.push({ type: "add", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      deletions += 1;
      current.lines.push({ type: "del", text: line.slice(1) });
    } else if (line.startsWith(" ") || line === "") current.lines.push({ type: "context", text: line.slice(1) });
  }
  if (!path && oldPath) path = oldPath;
  if (!path) path = stripPath(lines[0].slice("diff --git ".length).split(" b/").pop() ?? "");
  if (!path) return null;
  const tooLarge = chunk.length > MAX_PATCH_BYTES;
  return {
    path,
    oldPath: status === "renamed" ? oldPath : undefined,
    status,
    additions,
    deletions,
    binary: binary || undefined,
    tooLarge: tooLarge || undefined,
    hunks: binary || tooLarge ? [] : hunks,
  };
}

export async function collectSessionDiff(root: string): Promise<WorkspaceDiff> {
  const cwd = await realExistingPath(root);
  if (!cwd) return { repo: false, clean: true, files: [] };
  const probe = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (probe.code !== 0 || probe.stdout.trim() !== "true") return { repo: false, clean: true, files: [] };
  const status = await runGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status.code !== 0) return { repo: false, clean: true, files: [] };
  const entries = parseStatusZ(status.stdout);
  if (!entries.length) return { repo: true, clean: true, files: [] };
  const truncated = entries.length > MAX_DIFF_FILES;
  const scoped = entries.slice(0, MAX_DIFF_FILES);
  const untracked = new Set(scoped.filter((entry) => entry.untracked).map((entry) => entry.path));
  const files: DiffFile[] = [];
  const head = await runGit(cwd, ["rev-parse", "--verify", "HEAD"]);
  const base = head.code === 0 ? "HEAD" : "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const tracked = await runGit(cwd, ["diff", base, "--no-color", "--no-ext-diff", "-M", "--unified=3"]);
  for (const chunk of splitUnifiedDiff(tracked.stdout)) {
    const file = parseFilePatch(chunk);
    if (file && !untracked.has(file.path)) files.push(file);
  }
  for (const entry of scoped.filter((entry) => entry.untracked)) {
    const diff = await runGit(cwd, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--unified=3",
      "--no-index",
      "--",
      "/dev/null",
      entry.path,
    ]);
    const file = parseFilePatch(splitUnifiedDiff(diff.stdout)[0] ?? "", "untracked");
    files.push(file ?? {
      path: entry.path,
      status: "untracked",
      additions: 0,
      deletions: 0,
      hunks: [],
    });
  }
  return { repo: true, clean: false, files, ...(truncated ? { truncated } : {}) };
}
