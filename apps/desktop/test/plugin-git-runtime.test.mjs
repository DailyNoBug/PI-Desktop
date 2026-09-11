import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const hostProcessEntry = join(desktopRoot, "electron/main/plugin-host-process.mjs");

register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");

function forkPluginProcess({ entry }) {
  const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  return {
    postMessage: (message) => {
      if (child.connected) child.send(message);
    },
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    kill: () => child.kill(),
  };
}

async function harness(t, { id, permissions, git, consent, complete }) {
  const audits = [];
  const consents = [];
  const answers = [...(consent ?? [])];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    audit: (entry) => audits.push(entry),
    git,
    complete,
    ...(consent
      ? {
          confirmGitOperation: async (request) => {
            consents.push(request);
            return answers.length > 1 ? answers.shift() : (answers[0] ?? false);
          },
        }
      : {}),
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });

  const dir = mkdtempSync(join(tmpdir(), "pi-git-runtime-plugin-"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: `Plugin ${id}`,
      version: "0.0.1",
      main: "main.js",
      permissions,
    }),
    "utf8",
  );
  writeFileSync(join(dir, "main.js"), "module.exports = {};\n", "utf8");
  await runtime.loadFromPath(dir);
  return { runtime, audits, consents };
}

test("Git read and write channels enforce their declared permissions", async (t) => {
  const git = {
    status: async () => ({ repo: false, staged: [], unstaged: [], conflicts: [] }),
    stage: async () => ({ ok: true, status: { repo: false, staged: [], unstaged: [], conflicts: [] } }),
  };
  const readOnly = await harness(t, {
    id: "git.read.only",
    permissions: ["git.read"],
    git,
  });
  await assert.rejects(
    () => readOnly.runtime.invokePanelBridge("git.read.only", "git.stage", { paths: ["a"] }),
    (error) => error.code === "PERMISSION_DENIED",
  );
  assert.ok(
    readOnly.audits.some(
      (entry) => entry.api === "git.stage" && entry.errorCode === "PERMISSION_DENIED" && entry.pathCount === 1,
    ),
  );

  const writeOnly = await harness(t, {
    id: "git.write.only",
    permissions: ["git.write"],
    git,
  });
  await assert.rejects(
    () => writeOnly.runtime.invokePanelBridge("git.write.only", "git.status"),
    (error) => error.code === "PERMISSION_DENIED",
  );
  assert.ok(
    writeOnly.audits.some(
      (entry) => entry.api === "git.status" && entry.errorCode === "PERMISSION_DENIED",
    ),
  );
});

test("panel AI completions use the permissioned agent.complete channel", async (t) => {
  const completions = [];
  const complete = async (input) => {
    completions.push(input);
    return { text: "feat: update files", modelKey: input.modelKey };
  };
  const allowed = await harness(t, {
    id: "git.ai.allowed",
    permissions: ["agent.complete"],
    complete,
  });
  const result = await allowed.runtime.invokePanelBridge(
    "git.ai.allowed",
    "agent.complete",
    { modelKey: "provider/model", messages: [{ role: "user", content: "write a commit" }] },
  );
  assert.equal(result.text, "feat: update files");
  assert.equal(completions.length, 1);
  assert.equal(completions[0].modelKey, "provider/model");
  assert.deepEqual(completions[0].messages, [{ role: "user", content: "write a commit" }]);
  assert.ok(allowed.audits.some((entry) => entry.api === "agent.complete" && entry.ok === true));

  const denied = await harness(t, {
    id: "git.ai.denied",
    permissions: ["git.read"],
    complete,
  });
  await assert.rejects(
    () => denied.runtime.invokePanelBridge("git.ai.denied", "agent.complete", {
      modelKey: "provider/model",
    }),
    (error) => error.code === "PERMISSION_DENIED",
  );
  assert.ok(
    denied.audits.some((entry) => entry.api === "agent.complete" && entry.errorCode === "PERMISSION_DENIED"),
  );
});

test("dangerous Git operations require native confirmation before execution", async (t) => {
  const calls = [];
  const status = { repo: true, branch: "main", staged: [], unstaged: [], conflicts: [] };
  const git = {
    discard: async (input) => {
      calls.push(["discard", input]);
      return { ok: true, status };
    },
  };
  const { runtime, audits, consents } = await harness(t, {
    id: "git.confirm",
    permissions: ["git.write"],
    git,
    consent: [false, true],
  });

  await assert.rejects(
    () => runtime.invokePanelBridge("git.confirm", "git.discard", { paths: ["a", "b"] }),
    (error) => error.code === "PERMISSION_DENIED",
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(
    consents.map((request) => [request.operation, request.pathCount, request.branch]),
    [["discard", 2, undefined]],
  );

  await runtime.invokePanelBridge("git.confirm", "git.discard", { paths: ["a", "b"] });
  assert.deepEqual(calls, [["discard", { paths: ["a", "b"] }]]);
  assert.equal(consents.length, 2);
  assert.ok(audits.some((entry) => entry.api === "git.discard" && entry.ok === true && entry.pathCount === 2));
  assert.ok(audits.some((entry) => entry.api === "git.discard" && entry.errorCode === "PERMISSION_DENIED"));
});

test("branch-changing operations confirm and audit branch names only", async (t) => {
  const calls = [];
  const status = { repo: true, branch: "feature", staged: [], unstaged: [], conflicts: [] };
  const git = {
    createBranch: async (input) => {
      calls.push(["createBranch", input]);
      return { ok: true, status };
    },
    switchBranch: async (input) => {
      calls.push(["switchBranch", input]);
      return { ok: true, status };
    },
    commit: async (input) => {
      calls.push(["commit", input]);
      return { ok: true, status, commitHash: "1234567" };
    },
  };
  const { runtime, audits, consents } = await harness(t, {
    id: "git.branches",
    permissions: ["git.write"],
    git,
    consent: [true, true],
  });

  await runtime.invokePanelBridge("git.branches", "git.createBranch", {
    name: "feature",
    checkout: true,
  });
  await runtime.invokePanelBridge("git.branches", "git.switchBranch", {
    branch: "feature",
  });
  await runtime.invokePanelBridge("git.branches", "git.commit", {
    message: "private commit message",
  });

  assert.deepEqual(consents.map((request) => [request.operation, request.branch]), [
    ["create", "feature"],
    ["switch", "feature"],
  ]);
  assert.deepEqual(calls.map(([operation]) => operation), [
    "createBranch",
    "switchBranch",
    "commit",
  ]);
  assert.equal(audits.filter((entry) => entry.api === "git.createBranch").at(-1).branch, "feature");
  assert.equal(audits.filter((entry) => entry.api === "git.switchBranch").at(-1).branch, "feature");
  assert.ok(!JSON.stringify(audits).includes("private commit message"));
});

test("Git failures audit stable error codes without raw Git output", async (t) => {
  const git = {
    push: async () => {
      throw Object.assign(new Error("remote: https://user:secret-token@example.invalid failed"), {
        errorCode: "GIT_FAILED",
      });
    },
  };
  const { runtime, audits } = await harness(t, {
    id: "git.failure",
    permissions: ["git.write"],
    git,
  });

  await assert.rejects(
    () => runtime.invokePanelBridge("git.failure", "git.push", {}),
    (error) => error.code === "GIT_FAILED",
  );
  const entry = audits.find((item) => item.api === "git.push" && item.errorCode === "GIT_FAILED");
  assert.ok(entry);
  assert.equal(entry.ok, false);
  assert.ok(!JSON.stringify(audits).includes("secret-token"));
  assert.ok(!JSON.stringify(audits).includes("example.invalid"));
});

test("a missing Git service is audited before failing", async (t) => {
  const { runtime, audits } = await harness(t, {
    id: "git.unsupported",
    permissions: ["git.read"],
  });

  await assert.rejects(
    () => runtime.invokePanelBridge("git.unsupported", "git.status", {}),
    (error) => error.code === "UNSUPPORTED",
  );
  assert.ok(
    audits.some((entry) => entry.api === "git.status" && entry.ok === false && entry.errorCode === "UNSUPPORTED"),
  );
});
