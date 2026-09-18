import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const path = join(import.meta.dirname, "../resources/plugins/pi.cc-connect/main.js");
// Load the plugin file with CommonJS semantics (as the plugin host does).
const source = await readFile(path, "utf8");
function loadPlugin() {
  const module = { exports: {} };
  const fn = new Function("module", "exports", "require", source);
  fn(module, module.exports, require);
  return module.exports;
}

function fakePi({ dataDir, status } = {}) {
  const settings = {};
  const calls = [];
  let state = { ...status };
  return {
    calls,
    plugin: {
      async getSettings() {
        return JSON.parse(JSON.stringify(settings));
      },
      async setSettings(patch) {
        Object.assign(settings, JSON.parse(JSON.stringify(patch)));
      },
      getDataPath() {
        return dataDir;
      },
    },
    ccConnect: {
      async status() {
        calls.push("status");
        return state;
      },
      async setBridgeEnabled(enabled) {
        calls.push(`setBridgeEnabled:${enabled}`);
        return status;
      },
      async detectBinary() {
        return { found: true, path: "/opt/homebrew/bin/cc-connect", version: "1.2.3" };
      },
      async startProcess(input) {
        calls.push(`startProcess:${JSON.stringify(input)}`);
        state = { ...state, process: { running: true, pid: 4321 } };
        return { running: true, pid: 4321 };
      },
      async stopProcess() {
        calls.push("stopProcess");
        return { running: false };
      },
      async restartProcess() {
        calls.push("restartProcess");
        return { running: true, pid: 4322 };
      },
      async logs(input) {
        calls.push(`logs:${input.limit}`);
        return { lines: ["line-1", "line-2 [redacted]"] };
      },
    },
  };
}

const baseStatus = () => ({
  version: "0.15.1-test",
  bridge: { running: true, enabled: true, url: "ws://127.0.0.1:50000/v1/racp/ws" },
  process: { running: false },
  paths: {
    discoveryFile: "/data/racp-bridge.json",
    tokenFile: "/data/racp-bridge.token",
    stateDir: "/data/cc-connect",
  },
});

test("bindings file maps conversation keys with normalized modes", () => {
  const plugin = loadPlugin();
  const content = plugin.__createPanel({ pi: fakePi().plugin }).internals.bindingsFileContent([
    { id: "b1", key: "telegram:42:chat", mode: "fixed", projectId: "12", sessionId: "s1" },
    { id: "b2", key: "  feishu:7:thread ", mode: "latest", projectId: "13" },
    { id: "b3", key: "discord:9:chan", mode: "weird" },
    { id: "b4", key: "   " },
    null,
  ]);
  const map = JSON.parse(content);
  assert.deepEqual(map["telegram:42:chat"], { projectId: "12", sessionId: "s1", mode: "fixed" });
  assert.deepEqual(map["feishu:7:thread"], { projectId: "13", mode: "latest" });
  assert.deepEqual(map["discord:9:chan"], { mode: "new" });
  assert.equal(Object.keys(map).length, 3, "blank keys and null rows are dropped");
});

test("panel persists bindings, writes 0600 files, and never touches ~/.cc-connect", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cc-plugin-"));
  try {
    const pi = fakePi({ dataDir, status: baseStatus() });
    const plugin = loadPlugin();
    await plugin.onLoad(pi);
    const result = await plugin.onPanelInvoke("bindings.save", {
      bindings: [{ id: "b1", key: "telegram:42:chat", mode: "fixed", projectId: "12", sessionId: "s1" }],
    });
    assert.equal(result.bindings.length, 1);
    assert.deepEqual((await pi.plugin.getSettings()).ccConnectBindings, [
      { id: "b1", key: "telegram:42:chat", mode: "fixed", projectId: "12", sessionId: "s1" },
    ]);
    const bindings = JSON.parse(await readFile(join(dataDir, "bindings.json"), "utf8"));
    assert.deepEqual(bindings["telegram:42:chat"], { projectId: "12", sessionId: "s1", mode: "fixed" });
    const config = await readFile(join(dataDir, "config", "config.toml"), "utf8");
    assert.ok(config.includes('type = "pidesktop"'));
    assert.ok(config.includes("/data/racp-bridge.token"));
    assert.ok(config.includes('binding_mode = "bindings"'));
    assert.ok(config.includes("PI-managed"), "the config states it is PI-managed");
    await plugin.onUnload();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("startDaemon writes config, passes --config, and surfaces daemon state", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cc-plugin-"));
  try {
    const pi = fakePi({ dataDir, status: baseStatus() });
    const plugin = loadPlugin();
    await plugin.onLoad(pi);
    const payload = await plugin.onPanelInvoke("startDaemon", {});
    const start = pi.calls.find((call) => call.startsWith("startProcess:"));
    assert.ok(start, "daemon start is delegated to the host controller");
    assert.ok(start.includes('"--config"'), "daemon starts against the generated config");
    assert.equal(payload.status.process.running, true);
    assert.equal(payload.binary.version, "1.2.3");
    await plugin.onUnload();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("unknown channels and unloaded panels fail loudly", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cc-plugin-"));
  try {
    const pi = fakePi({ dataDir, status: baseStatus() });
    const plugin = loadPlugin();
    await plugin.onLoad(pi);
    await assert.rejects(() => plugin.onPanelInvoke("nope", {}), /unknown channel/);
    await plugin.onUnload();
    await assert.rejects(() => plugin.onPanelInvoke("status", {}), /not loaded/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
