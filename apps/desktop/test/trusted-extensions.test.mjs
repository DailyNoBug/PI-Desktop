import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TrustedExtensionsRegistry } from "../electron/main/trusted-extensions.ts";

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "pi-trusted-ext-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  mkdirSync(join(project, ".pi", "extensions"), { recursive: true });
  writeFileSync(join(agentDir, "extensions", "hello.ts"), "export default function () {}\n");
  writeFileSync(join(project, ".pi", "extensions", "tool.ts"), "export default function () {}\n");
  return { root, agentDir, project };
}

function registry(paths, overrides = {}) {
  const events = { changed: 0, prompts: [], toasts: [], statuses: [] };
  const reg = new TrustedExtensionsRegistry({
    storePath: join(paths.root, "store", "trusted-extensions.json"),
    agentDir: paths.agentDir,
    hasRenderer: () => true,
    onChanged: () => {
      events.changed += 1;
    },
    onPrompt: (prompt) => events.prompts.push(prompt),
    onToast: (message, level) => events.toasts.push({ message, level }),
    onStatus: (event) => events.statuses.push(event),
    promptTimeoutMs: 50,
    ...overrides,
  });
  return { reg, events };
}

test("discovery lists user and project entries disabled; enablement is explicit and persisted", () => {
  const paths = scratch();
  const { reg, events } = registry(paths);
  const first = reg.list(paths.project);
  assert.deepEqual(
    first.entries.map((e) => [e.label, e.source, e.enabled, e.state]),
    [
      ["hello", "user", false, "disabled"],
      ["tool", "project", false, "disabled"],
    ],
  );
  assert.equal(first.roots.user, join(paths.agentDir, "extensions"));
  assert.deepEqual(reg.enabledSpecsFor(paths.project), []);

  const hello = first.entries[0];
  const tool = first.entries[1];
  reg.setEnabled(hello.id, true, paths.project);
  reg.setEnabled(tool.id, true, paths.project);
  assert.equal(events.changed, 2);
  assert.deepEqual(
    reg.enabledSpecsFor(paths.project).map((s) => s.label),
    ["hello", "tool"],
  );
  // A different project sees only the user entry.
  assert.deepEqual(reg.enabledSpecsFor(join(paths.root, "other")).map((s) => s.label), ["hello"]);

  // Persisted across instances.
  const { reg: again } = registry(paths);
  assert.deepEqual(again.enabledSpecsFor(paths.project).map((s) => s.label), ["hello", "tool"]);
  assert.equal(again.list(paths.project).entries[0].enabled, true);
  assert.equal(again.list(paths.project).entries[0].state, "enabled", "no session has loaded it yet");
});

test("a deleted enabled entry shows missing and keeps its flag until removed; rescan drops disabled orphans", () => {
  const paths = scratch();
  const { reg } = registry(paths);
  const [hello] = reg.list().entries;
  reg.setEnabled(hello.id, true);
  const spare = join(paths.agentDir, "extensions", "spare.ts");
  writeFileSync(spare, "export default function () {}\n");
  const spareEntry = reg.list().entries.find((e) => e.label === "spare");
  reg.setEnabled(spareEntry.id, true);
  reg.setEnabled(spareEntry.id, false);

  rmSync(join(paths.agentDir, "extensions", "hello.ts"));
  rmSync(spare);
  const listed = reg.list();
  assert.deepEqual(
    listed.entries.map((e) => [e.label, e.enabled, e.missing, e.state]),
    [["hello", true, true, "missing"]],
  );
  assert.deepEqual(reg.enabledSpecsFor(), []);
  assert.throws(() => reg.setEnabled(hello.id, true), /missing/);

  const rescanned = reg.rescan();
  assert.equal(rescanned.entries.length, 1, "enabled missing entry survives rescan");
  reg.remove(hello.id);
  assert.deepEqual(reg.list().entries, []);
});

test("manual paths are validated, added once, and removed with their last entry", () => {
  const paths = scratch();
  const { reg } = registry(paths);
  assert.throws(() => reg.addPath(join(paths.root, "nowhere")), /no extension entry/);
  const manualDir = join(paths.root, "manual");
  mkdirSync(manualDir);
  writeFileSync(join(manualDir, "index.ts"), "export default function () {}\n");
  reg.addPath(manualDir);
  reg.addPath(manualDir);
  const entry = reg.list().entries.find((e) => e.source === "manual");
  assert.equal(entry.label, "manual");
  assert.deepEqual(reg.list().roots.manual, [manualDir]);
  reg.setEnabled(entry.id, true);
  reg.remove(entry.id);
  assert.deepEqual(reg.list().roots.manual, []);
  assert.equal(reg.list().entries.some((e) => e.source === "manual"), false);
});

test("session publications drive entry state, tool names, diagnostics, and the command list", () => {
  const paths = scratch();
  const { reg, events } = registry(paths);
  const [hello] = reg.list().entries;
  reg.setEnabled(hello.id, true);
  reg.publishDiagnostics("s1", [{ extensionId: hello.id, kind: "unsupported_api", message: "x", member: "setWidget", count: 2 }], [
    { extensionId: hello.id, state: "loaded", toolNames: ["fx_add"], commandNames: ["greet"], eventNames: [] },
  ]);
  reg.publishCommands("s1", [{ extensionId: hello.id, extensionLabel: "hello", name: "greet", description: "hi" }]);
  reg.publishCommands("s2", [{ extensionId: hello.id, extensionLabel: "hello", name: "greet" }, { extensionId: hello.id, extensionLabel: "hello", name: "other" }]);
  const entry = reg.list().entries[0];
  assert.equal(entry.state, "loaded");
  assert.deepEqual(entry.toolNames, ["fx_add"]);
  assert.deepEqual(entry.commandNames, ["greet"]);
  assert.equal(entry.diagnostics[0].member, "setWidget");
  assert.deepEqual(reg.allCommands().map((c) => [c.name, c.description]), [["greet", "hi"], ["other", undefined]]);
  assert.deepEqual(reg.commandsForSession("s2").map((c) => c.name), ["greet", "other"]);

  reg.publishDiagnostics("s1", [], [{ extensionId: hello.id, state: "error", toolNames: [], commandNames: [], eventNames: [] }]);
  assert.equal(reg.list().entries[0].state, "error");
  reg.clearSession("s1");
  reg.clearSession("s2");
  assert.deepEqual(reg.allCommands(), []);
  assert.ok(events.changed >= 6);
});

test("ui requests: notify and status pass through; prompts round-trip, queue per session, time out, and cancel on abort", async () => {
  const paths = scratch();
  const { reg, events } = registry(paths);
  const envelope = (request, sessionId = "s1") => ({
    sessionId,
    extensionId: "ext",
    extensionLabel: "Hello",
    request,
  });
  assert.deepEqual(await reg.requestUi(envelope({ kind: "notify", message: "hi", level: "warning" })), { kind: "notify" });
  assert.deepEqual(events.toasts, [{ message: "Hello: hi", level: "warning" }]);
  await reg.requestUi(envelope({ kind: "setStatus", key: "k", text: "busy" }));
  await reg.requestUi(envelope({ kind: "setWorkingMessage", text: undefined }));
  assert.deepEqual(events.statuses.map((s) => [s.key, s.text]), [["k", "busy"], ["working", undefined]]);

  const confirm = reg.requestUi(envelope({ kind: "confirm", title: "Sure?", message: "really" }));
  const select = reg.requestUi(envelope({ kind: "select", title: "Pick", options: ["a", "b"] }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(events.prompts.length, 1, "second prompt waits behind the first");
  assert.equal(reg.respond("nope", true), false);
  assert.equal(reg.respond(events.prompts[0].promptId, true), true);
  assert.deepEqual(await confirm, { kind: "confirm", value: true });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(events.prompts.length, 2);
  reg.respond(events.prompts[1].promptId, "b");
  assert.deepEqual(await select, { kind: "select", value: "b" });

  const timedOut = reg.requestUi(envelope({ kind: "input", title: "Name" }));
  assert.deepEqual(await timedOut, { kind: "input", value: undefined });

  const aborted = reg.requestUi(envelope({ kind: "confirm", title: "x", message: "" }, "s9"));
  await new Promise((r) => setTimeout(r, 0));
  reg.cancelPrompts("s9");
  assert.deepEqual(await aborted, { kind: "confirm", value: false });
  assert.equal(reg.pendingPromptCount(), 0);

  const { reg: headless } = registry(paths, { hasRenderer: () => false });
  await assert.rejects(
    headless.requestUi(envelope({ kind: "input", title: "x" })),
    (err) => err.errorCode === "UNSUPPORTED",
  );
});
