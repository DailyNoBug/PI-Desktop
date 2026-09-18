import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(here, "..", "resources", "plugins", "pi.local-voice");
const { REQUIRED_FILES, assertAllowedHost } = require(join(PLUGIN_DIR, "lib", "downloader.js"));

/** Load the plugin entry with a stubbed `pi` host and stubbable engine. */
async function loadPlugin({ engine } = {}) {
  const dataPath = mkdtempSync(join(tmpdir(), "pi-local-voice-plugin-"));
  const modelsDir = join(dataPath, "models");
  mkdirSync(modelsDir, { recursive: true });
  const registrations = { adapters: [], rpc: null, unregistered: [] };
  globalThis.pi = {
    plugin: {
      getDataPath: async () => dataPath,
      getManifest: async () => ({ id: "pi.local-voice", net: { domains: [] } }),
    },
    speech: {
      registerAdapter: async (adapter) => registrations.adapters.push(adapter),
      unregisterAdapter: async (protocol) => registrations.unregistered.push(protocol),
    },
    rpc: {
      register: async (handler) => {
        registrations.rpc = handler;
      },
      unregister: async () => {
        registrations.rpc = null;
      },
    },
  };
  const enginePath = join(PLUGIN_DIR, "lib", "engine.js");
  if (engine) {
    require.cache[enginePath] = {
      id: enginePath,
      filename: enginePath,
      loaded: true,
      exports: { createEngine: () => engine },
    };
  }
  const previousCache = require.cache[enginePath];
  // Fresh module per test: main.js keeps model state in module scope and its
  // `require("./lib/engine")` must re-resolve so the stub (if any) applies.
  delete require.cache[join(PLUGIN_DIR, "main.js")];
  const plugin = require(join(PLUGIN_DIR, "main.js"));
  await plugin.onLoad();
  const cleanup = async () => {
    await plugin.onUnload();
    if (engine) delete require.cache[enginePath];
    else if (previousCache) require.cache[enginePath] = previousCache;
    delete globalThis.pi;
    rmSync(dataPath, { recursive: true, force: true });
  };
  return { dataPath, modelsDir, registrations, plugin, rpc: () => registrations.rpc, cleanup };
}

function fakeInstall(modelsDir, repoId) {
  for (const file of REQUIRED_FILES) {
    const target = join(modelsDir, repoId, file);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "stub");
  }
}

test("onLoad registers the speech adapter and the rpc handler", async () => {
  const ctx = await loadPlugin();
  try {
    assert.equal(ctx.registrations.adapters.length, 1);
    assert.equal(ctx.registrations.adapters[0].protocol, "pi.local_voice");
    assert.deepEqual(ctx.registrations.adapters[0].roles, ["transcribe"]);
    assert.equal(typeof ctx.rpc(), "function");
  } finally {
    await ctx.cleanup();
  }
});

test("rpc status and models.list describe an empty installation", async () => {
  const ctx = await loadPlugin();
  try {
    const status = await ctx.rpc()("status");
    assert.equal(status.ready, false);
    assert.equal(status.activeModel, null);
    assert.equal(status.models.length, 3);
    const list = await ctx.rpc()("models.list");
    assert.ok(list.models.every((model) => model.installed === false));
  } finally {
    await ctx.cleanup();
  }
});

test("models.setActive requires an installed model and persists", async () => {
  const ctx = await loadPlugin({ engine: { isAvailable: () => true } });
  try {
    const refused = await ctx.rpc()("models.setActive", { id: "whisper-tiny" });
    assert.equal(refused.ok, false);
    fakeInstall(ctx.modelsDir, "Xenova/whisper-tiny");
    const ok = await ctx.rpc()("models.setActive", { id: "whisper-tiny" });
    assert.equal(ok.ok, true);
    assert.equal(ok.ready, true);
    const status = await ctx.rpc()("status");
    assert.equal(status.ready, true);
    assert.equal(status.activeModel, "whisper-tiny");
  } finally {
    await ctx.cleanup();
  }
});

test("models.remove refuses the active model while another is installed", async () => {
  const ctx = await loadPlugin({ engine: { isAvailable: () => true } });
  try {
    fakeInstall(ctx.modelsDir, "Xenova/whisper-tiny");
    fakeInstall(ctx.modelsDir, "Xenova/whisper-base");
    await ctx.rpc()("models.setActive", { id: "whisper-tiny" });
    const refused = await ctx.rpc()("models.remove", { id: "whisper-tiny" });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "active");
    const inactive = await ctx.rpc()("models.remove", { id: "whisper-base" });
    assert.equal(inactive.ok, true);
  } finally {
    await ctx.cleanup();
  }
});

test("speech.handle fails closed without a model and gates silence", async () => {
  const ctx = await loadPlugin({ engine: { isAvailable: () => true } });
  try {
    await assert.rejects(
      () => ctx.registrations.adapters[0].handle({ audio: Buffer.from([1, 0]).toString("base64") }),
      /model is not downloaded/,
    );
    fakeInstall(ctx.modelsDir, "Xenova/whisper-tiny");
    await ctx.rpc()("models.setActive", { id: "whisper-tiny" });
    await assert.rejects(
      () =>
        ctx.registrations.adapters[0].handle({
          audio: Buffer.alloc(32000).toString("base64"),
          language: "zh-CN",
        }),
      /no speech detected/,
    );
  } finally {
    await ctx.cleanup();
  }
});
test("active model choice survives a plugin reload", async () => {
  const first = await loadPlugin({ engine: { isAvailable: () => true } });
  const dataPath = first.dataPath;
  fakeInstall(first.modelsDir, "Xenova/whisper-base");
  await first.rpc()("models.setActive", { id: "whisper-base" });
  // Unload without wiping the data dir: state.json must survive the restart.
  await first.plugin.onUnload();
  delete require.cache[join(PLUGIN_DIR, "main.js")];
  delete globalThis.pi;

  // Simulate an app restart: a fresh plugin module reading the same data dir.
  const mainPath = join(PLUGIN_DIR, "main.js");
  const restarted = { rpc: null };
  globalThis.pi = {
    plugin: {
      getDataPath: async () => dataPath,
      getManifest: async () => ({ id: "pi.local-voice", net: { domains: [] } }),
    },
    speech: { registerAdapter: async () => {}, unregisterAdapter: async () => {} },
    rpc: {
      register: async (handler) => {
        restarted.rpc = handler;
      },
      unregister: async () => {},
    },
  };
  try {
    delete require.cache[mainPath];
    const restartedModule = require(mainPath);
    await restartedModule.onLoad();
  } finally {
    delete globalThis.pi;
  }
  const status = await restarted.rpc("status");
  assert.equal(status.activeModel, "whisper-base");
  assert.equal(status.ready, true);
  delete require.cache[mainPath];
  rmSync(dataPath, { recursive: true, force: true });
});

test("speech.handle returns text via the engine", async () => {
  const ctx = await loadPlugin({
    engine: {
      isAvailable: () => true,
      transcribe: async ({ language }) => ({ text: ` heard:${language ?? "none"}` }),
    },
  });
  try {
    fakeInstall(ctx.modelsDir, "Xenova/whisper-tiny");
    await ctx.rpc()("models.setActive", { id: "whisper-tiny" });
    const loud = Buffer.alloc(32000);
    for (let i = 0; i < loud.length; i += 2) loud.writeInt16LE(8000, i);
    const reply = await ctx.registrations.adapters[0].handle({
      audio: loud.toString("base64"),
      language: "zh-CN",
    });
    assert.equal(reply.kind, "text");
    assert.equal(reply.text, "heard:zh-CN");
  } finally {
    await ctx.cleanup();
  }
});

test("downloader allowlist matches manifest domains", () => {
  const domains = ["huggingface.co", "*.huggingface.co", "*.hf.co", "*.xethub.hf.co"];
  assert.doesNotThrow(() => assertAllowedHost("https://huggingface.co/x/resolve/main/a", domains));
  assert.doesNotThrow(() => assertAllowedHost("https://cdn-lfs.huggingface.co/a", domains));
  assert.doesNotThrow(() => assertAllowedHost("https://cas-bridge.xethub.hf.co/a", domains));
  assert.throws(() => assertAllowedHost("https://evil.test/a", domains), /allowlist/);
  assert.throws(() => assertAllowedHost("https://huggingface.co.evil.com/a", domains), /allowlist/);
  assert.throws(() => assertAllowedHost("http://huggingface.co/a", domains), /https/);
});
