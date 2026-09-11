import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register(pathToFileURL(join(import.meta.dirname, "helpers/ts-import-hooks.mjs")));
const { GitService, parseGitStatusV2 } = await import("../electron/main/git-service.ts");
const { parseFilePatch } = await import("../electron/main/git-diff.ts");
const run = promisify(execFile);

async function git(cwd, ...args) {
  return run("git", args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "pi-git-service-"));
  const service = new GitService({ getWorkspacePath: () => root });
  await git(root, "init", "--initial-branch=main");
  await git(root, "config", "user.name", "Test User");
  await git(root, "config", "user.email", "test@example.invalid");
  await writeFile(join(root, "a.txt"), "one\n", "utf8");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial");
  return { root, service };
}

test("parses porcelain v2 branch, staged, worktree, rename, and conflict records", () => {
  const raw = [
    "# branch.oid 1111111111111111111111111111111111111111",
    "# branch.head feature",
    "# branch.upstream origin/feature",
    "# branch.ab +2 -1",
    "1 .M N... 100644 100644 100644 222 333 work.txt",
    "1 M. N... 100644 100644 100644 222 333 index.txt",
    "2 R. N... 100644 100644 100644 222 333 new.txt",
    "old.txt",
    "? untracked.txt",
    "u UU N... 100644 100644 100644 100644 222 222 333 conflict.txt",
  ].join("\0") + "\0";
  const parsed = parseGitStatusV2(raw);
  assert.equal(parsed.branch, "feature");
  assert.equal(parsed.upstream, "origin/feature");
  assert.deepEqual([parsed.ahead, parsed.behind], [2, 1]);
  assert.equal(parsed.entries.length, 5);
  assert.deepEqual(
    parsed.entries.map((entry) => [entry.path, entry.index, entry.worktree, entry.untracked, entry.unmerged]),
    [
      ["work.txt", ".", "M", false, false],
      ["index.txt", "M", ".", false, false],
      ["new.txt", "R", ".", false, false],
      ["untracked.txt", "?", "?", true, false],
      ["conflict.txt", "U", "U", false, true],
    ],
  );
  assert.equal(parsed.entries.find((entry) => entry.path === "new.txt").oldPath, "old.txt");
});

test("status separates staged, worktree, rename, and untracked changes", async () => {
  const { root, service } = await repository();
  await writeFile(join(root, "a.txt"), "one\ntwo\n", "utf8");
  await writeFile(join(root, "new.txt"), "new\n", "utf8");
  await writeFile(join(root, "draft.txt"), "draft\n", "utf8");
  await git(root, "add", "a.txt");
  const status = await service.status();
  assert.equal(status.repo, true);
  assert.equal(status.branch, "main");
  assert.deepEqual(status.staged.map((change) => change.path), ["a.txt"]);
  assert.deepEqual(status.unstaged.map((change) => change.path), ["draft.txt", "new.txt"]);
  assert.deepEqual(status.unstaged.find((change) => change.path === "a.txt"), undefined);
  assert.equal(status.unstaged.find((change) => change.path === "new.txt").additions, 1);

  await git(root, "add", "new.txt");
  await git(root, "commit", "-m", "add new");
  await git(root, "mv", "new.txt", "renamed.txt");
  const renamed = (await service.status()).staged.find((change) => change.path === "renamed.txt");
  assert.equal(renamed.oldPath, "new.txt");
  assert.equal(renamed.status, "renamed");
});

test("patch hunks retain their old and new starting line numbers", () => {
  const file = parseFilePatch([
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -8,2 +8,3 @@ context",
    " context",
    "+added",
    "@@ -22,3 +23,3 @@ context",
    "-removed",
    " context",
  ].join("\n"));
  assert.deepEqual(
    file.hunks.map((hunk) => [hunk.oldStart, hunk.newStart]),
    [[8, 8], [22, 23]],
  );
});

test("stage, unstage, scoped diff, discard, commit, and initial-repo reset stay bounded", async () => {
  const { root, service } = await repository();
  await writeFile(join(root, "a.txt"), "one\nreplaced\n", "utf8");
  await writeFile(join(root, "untracked.txt"), "fresh\n", "utf8");
  await service.stage({ paths: ["a.txt"] });
  const stagedDiff = await service.diff({ path: "a.txt", scope: "staged" });
  assert.equal(stagedDiff.file.additions, 1);
  assert.equal(stagedDiff.file.deletions, 0);
  const untrackedDiff = await service.diff({ path: "untracked.txt", scope: "untracked" });
  assert.equal(untrackedDiff.file.status, "untracked");
  assert.equal(untrackedDiff.file.additions, 1);

  await service.unstage({ paths: ["a.txt"] });
  assert.equal((await service.status()).staged.length, 0);
  await service.stage({ paths: ["a.txt"] });
  const operation = await service.commit({ message: "update a" });
  assert.match(operation.commitHash, /^[0-9a-f]{7,}$/);

  const trashed = [];
  const discardService = new GitService({
    getWorkspacePath: () => root,
    trashItem: async (path) => {
      await rm(path, { force: true });
      trashed.push(path);
    },
  });
  await writeFile(join(root, "a.txt"), "changed\n", "utf8");
  await writeFile(join(root, "temporary.txt"), "temporary\n", "utf8");
  await discardService.discard({ paths: ["a.txt", "temporary.txt"] });
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "one\nreplaced\n");
  assert.equal(trashed.length, 1);
  assert.equal(trashed[0], join(root, "temporary.txt"));

  const initialRoot = await mkdtemp(join(tmpdir(), "pi-git-initial-"));
  const initialService = new GitService({ getWorkspacePath: () => initialRoot });
  await git(initialRoot, "init", "--initial-branch=main");
  await writeFile(join(initialRoot, "first.txt"), "first\n", "utf8");
  await initialService.stage({ paths: ["first.txt"] });
  await initialService.unstage({ paths: ["first.txt"] });
  assert.equal((await initialService.status()).initialBranch, true);
  assert.equal((await initialService.status()).staged.length, 0);
});

test("branch creation and switching update current state", async () => {
  const { root, service } = await repository();
  await service.createBranch({ name: "feature", checkout: true });
  assert.equal((await service.status()).branch, "feature");
  const branches = await service.branches();
  assert.deepEqual(branches.branches.map((branch) => branch.name), ["feature", "main"]);
  assert.equal(branches.currentBranch, "feature");
  await service.switchBranch({ branch: "main" });
  assert.equal((await service.status()).branch, "main");
});

test("push publishes to origin and pull advances only when fast-forward is possible", async () => {
  const { root, service } = await repository();
  const remoteRoot = await mkdtemp(join(tmpdir(), "pi-git-remote-"));
  await git(remoteRoot, "init", "--bare", "--initial-branch=main");
  await git(root, "remote", "add", "origin", remoteRoot);
  await service.push({ publish: true });
  assert.equal((await service.status()).upstream, "origin/main");

  const cloneRoot = await mkdtemp(join(tmpdir(), "pi-git-clone-"));
  await run("git", ["clone", remoteRoot, cloneRoot], { env: process.env });
  await git(cloneRoot, "config", "user.name", "Other User");
  await git(cloneRoot, "config", "user.email", "other@example.invalid");
  await writeFile(join(cloneRoot, "remote.txt"), "remote\n", "utf8");
  await git(cloneRoot, "add", ".");
  await git(cloneRoot, "commit", "-m", "remote change");
  await git(cloneRoot, "push");
  await service.pull();
  assert.equal(await readFile(join(root, "remote.txt"), "utf8"), "remote\n");

  await writeFile(join(root, "a.txt"), "local divergence\n", "utf8");
  await git(root, "commit", "-am", "local change");
  await writeFile(join(cloneRoot, "remote.txt"), "second remote\n", "utf8");
  await git(cloneRoot, "commit", "-am", "second remote change");
  await git(cloneRoot, "push");
  await assert.rejects(() => service.pull(), (error) => {
    assert.equal(error.errorCode, "GIT_FAILED");
    assert.match(error.message, /Not possible to fast-forward|diverged/i);
    return true;
  });
});

test("hook failure, invalid paths, and invalid scopes return stable errors", async () => {
  const { root, service } = await repository();
  await writeFile(join(root, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 17\n", {
    mode: 0o755,
  });
  await writeFile(join(root, "hooked.txt"), "hooked\n", "utf8");
  await service.stage({ paths: ["hooked.txt"] });
  await assert.rejects(() => service.commit({ message: "hook should fail" }), (error) => {
    assert.equal(error.errorCode, "GIT_FAILED");
    return true;
  });
  await assert.rejects(
    () => service.diff({ path: "../outside.txt", scope: "staged" }),
    (error) => error.errorCode === "GIT_PATH_DENIED",
  );
  await assert.rejects(
    () => service.diff({ path: "a.txt", scope: "head" }),
    (error) => error.errorCode === "INVALID_ARGUMENT",
  );
});

test("concurrent mutations serialize per workspace", async () => {
  const { root, service } = await repository();
  await writeFile(join(root, "serial.txt"), "serial\n", "utf8");
  const first = service.stage({ paths: ["serial.txt"] });
  const second = service.stage({ all: true });
  const results = await Promise.allSettled([first, second]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "fulfilled");
  assert.equal((await service.status()).staged.length, 1);
});

test("path operations require an explicit selection and discard staged additions safely", async () => {
  const { root, service } = await repository();
  await writeFile(join(root, "staged-addition.txt"), "temporary\n", "utf8");
  await service.stage({ paths: ["staged-addition.txt"] });

  await assert.rejects(() => service.stage({}), (error) => error.errorCode === "INVALID_ARGUMENT");
  await assert.rejects(() => service.unstage({}), (error) => error.errorCode === "INVALID_ARGUMENT");
  await assert.rejects(
    () => service.discard({ paths: ["a.txt"] }),
    (error) => error.errorCode === "GIT_PATH_DENIED",
  );

  const trashed = [];
  const discardService = new GitService({
    getWorkspacePath: () => root,
    trashItem: async (path) => {
      await rm(path, { force: true });
      trashed.push(path);
    },
  });
  const result = await discardService.discard({ paths: ["staged-addition.txt"] });
  assert.equal(result.status.staged.length, 0);
  assert.equal(result.status.unstaged.length, 0);
  assert.deepEqual(trashed, [join(root, "staged-addition.txt")]);
});

test("branch names reject option-like and malformed ref forms", async () => {
  const { service } = await repository();
  for (const name of ["-feature", "..feature", "feature..main", ".feature", "feature.", "feature.lock", "feature/.inner", "feature//main"]) {
    await assert.rejects(
      () => service.createBranch({ name, checkout: true }),
      (error) => error.errorCode === "INVALID_ARGUMENT",
    );
  }
});
