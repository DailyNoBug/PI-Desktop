import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const hostProcessEntry = join(here, "..", "electron/main/plugin-host-process.mjs");
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const dataDir = mkdtempSync(join(tmpdir(), "pi-plugin-rpc-data-"));
process.env.PI_DESKTOP_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");

const PLUGIN_ID = "com.example.rpc";

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

function writePlugin(t, { permissions, main }) {
  const dir = mkdtempSync(join(tmpdir(), "pi-plugin-rpc-plugin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: PLUGIN_ID,
      name: "RPC Plugin",
      version: "0.0.1",
      main: "main.js",
      permissions,
    }),
    "utf8",
  );
  writeFileSync(join(dir, "main.js"), main, "utf8");
  return dir;
}

function createRuntime(t) {
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  return runtime;
}

const RPC_MAIN = `
  module.exports = {
    async onLoad() {
      await pi.rpc.register(async (method, params) => {
        if (method === "echo") return { echo: params?.value ?? null };
        if (method === "fail") throw new Error("boom");
        throw new Error("unknown method: " + method);
      });
    },
  };
`;

test("runPluginRpc routes renderer calls to the plugin handler", async (t) => {
  const runtime = createRuntime(t);
  await runtime.loadFromPath(
    writePlugin(t, { permissions: ["plugin.rpc"], main: RPC_MAIN }),
  );
  const result = await runtime.runPluginRpc(PLUGIN_ID, "echo", { value: 42 });
  assert.deepEqual(result, { echo: 42 });
  await assert.rejects(
    () => runtime.runPluginRpc(PLUGIN_ID, "fail"),
    (error) => error.message.includes("boom"),
  );
});

test("unload drops the rpc handler", async (t) => {
  const runtime = createRuntime(t);
  await runtime.loadFromPath(
    writePlugin(t, { permissions: ["plugin.rpc"], main: RPC_MAIN }),
  );
  await runtime.unload(PLUGIN_ID);
  await assert.rejects(
    () => runtime.runPluginRpc(PLUGIN_ID, "echo"),
    (error) => error.code === "NOT_FOUND",
  );
});

test("unknown plugin has no rpc handler", async (t) => {
  const runtime = createRuntime(t);
  await assert.rejects(
    () => runtime.runPluginRpc("com.example.missing", "echo"),
    (error) => error.code === "NOT_FOUND",
  );
});
