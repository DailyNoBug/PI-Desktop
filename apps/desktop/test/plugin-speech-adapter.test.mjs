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

const dataDir = mkdtempSync(join(tmpdir(), "pi-speech-data-"));
process.env.PI_DESKTOP_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");

const PLUGIN_ID = "com.example.speech";

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
  const dir = mkdtempSync(join(tmpdir(), "pi-speech-plugin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: PLUGIN_ID,
      name: "Speech Plugin",
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

const REGISTER_MAIN = `
  module.exports = {
    async onLoad() {
      await pi.speech.registerAdapter({
        protocol: "example.tts",
        label: "Example TTS",
        roles: ["synthesize"],
        handle: async (input) => {
          if (input.role !== "synthesize") throw Object.assign(new Error("no"), { code: "SPEECH_PROTOCOL_UNSUPPORTED" });
          if (input.extra?.mode === "http") {
            return { kind: "http", call: { url: input.extra.url, parse: input.extra.parse || "bytes" } };
          }
          return { kind: "audio", mimeType: "audio/wav", data: Buffer.from("RIFF").toString("base64") };
        },
      });
    },
  };
`;

test("a plugin can register a speech adapter and handle synthesis", async (t) => {
  const runtime = createRuntime(t);
  await runtime.loadFromPath(writePlugin(t, { permissions: ["speech.adapter.register"], main: REGISTER_MAIN }));
  const listed = runtime.listSpeechAdapters();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, "example.tts");
  assert.deepEqual(listed[0].roles, ["synthesize"]);
  const reply = await runtime.runSpeechAdapter(
    { role: "synthesize", binding: { protocol: "example.tts" } },
    { modelId: "demo" },
  );
  assert.equal(reply.kind, "audio");
  assert.equal(Buffer.from(reply.data, "base64").toString(), "RIFF");
});

test("unload drops the adapter", async (t) => {
  const runtime = createRuntime(t);
  await runtime.loadFromPath(writePlugin(t, { permissions: ["speech.adapter.register"], main: REGISTER_MAIN }));
  await runtime.unload(PLUGIN_ID);
  assert.equal(runtime.listSpeechAdapters().length, 0);
});

test("http plans require a parseable call", async (t) => {
  const runtime = createRuntime(t);
  await runtime.loadFromPath(writePlugin(t, { permissions: ["speech.adapter.register"], main: REGISTER_MAIN }));
  const reply = await runtime.runSpeechAdapter(
    { role: "synthesize", binding: { protocol: "example.tts" } },
    { modelId: "demo", extra: { mode: "http", url: "https://api.example.com/v1/audio/speech" } },
  );
  assert.equal(reply.kind, "http");
  assert.equal(reply.call.url, "https://api.example.com/v1/audio/speech");
  await assert.rejects(
    () =>
      runtime.runSpeechAdapter(
        { role: "synthesize", binding: { protocol: "example.tts" } },
        { modelId: "demo", extra: { mode: "http", url: "https://evil.test/x", parse: "nope" } },
      ),
    (error) => error.code === "INVALID_ARGUMENT",
  );
});


