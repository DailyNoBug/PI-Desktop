import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  browseRemotePath,
  collectSessionDiff,
  listSessionWorkspace,
  readSessionWorkspace,
} from "./workspace.js";

const run = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  directories.length = 0;
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

describe("pi-host workspace boundary", () => {
  it("lists and reads only contained remote paths", async () => {
    const root = await temporaryDirectory("pi-host-workspace-");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "main.ts"), "export const answer = 42;\n");
    await writeFile(join(root, "secret.txt"), "secret");
    const outside = await temporaryDirectory("pi-host-outside-");
    await writeFile(join(outside, "outside.txt"), "outside");
    await symlink(join(outside, "outside.txt"), join(root, "outside.txt"));

    const entries = await listSessionWorkspace(root, "src");
    expect(entries).toEqual([{ name: "main.ts", kind: "file", size: 26 }]);
    const read = await readSessionWorkspace(root, "src/main.ts");
    expect(read.kind).toBe("text");
    expect(read.content).toContain("answer = 42");
    await expect(readSessionWorkspace(root, "../secret.txt")).rejects.toMatchObject({
      errorCode: "PATH_OUTSIDE_WORKSPACE",
    });
    await expect(readSessionWorkspace(root, "outside.txt")).rejects.toMatchObject({
      errorCode: "PATH_OUTSIDE_WORKSPACE",
    });
  });

  it("browses a remote directory and reports repository state", async () => {
    const root = await temporaryDirectory("pi-host-browse-");
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, "a.txt"), "a");
    const result = await browseRemotePath(root, root);
    expect(result.path).toBe(await realpath(root));
    expect(result.isGitRepository).toBe(true);
    expect(result.entries.map((entry) => entry.name)).toEqual(["a.txt"]);
  });

  it("collects a structured working-tree diff", async () => {
    const root = await temporaryDirectory("pi-host-diff-");
    await writeFile(join(root, "tracked.txt"), "one\n");
    await run("git", ["init"], { cwd: root });
    await run("git", ["config", "user.email", "test@example.test"], { cwd: root });
    await run("git", ["config", "user.name", "Test"], { cwd: root });
    await run("git", ["add", "tracked.txt"], { cwd: root });
    await run("git", ["commit", "-m", "initial"], { cwd: root });
    await writeFile(join(root, "tracked.txt"), "one\ntwo\n");
    await writeFile(join(root, "untracked.txt"), "new\n");

    const diff = await collectSessionDiff(root);
    expect(diff.repo).toBe(true);
    expect(diff.clean).toBe(false);
    expect(diff.files.map((file) => `${file.status}:${file.path}`).sort()).toEqual([
      "modified:tracked.txt",
      "untracked:untracked.txt",
    ]);
  });
});
