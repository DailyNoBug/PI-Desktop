import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("plugin rpc is on the typed whitelist and renderer API", async () => {
  const [protocol, api, pluginIpc] = await Promise.all([
    read("../../../packages/shared/src/protocol.ts"),
    read("../src/lib/api.ts"),
    read("../electron/main/ipc/plugin-ipc.ts"),
  ]);
  assert.match(protocol, /pluginRpc: "pi-desktop\/plugin\/rpc"/);
  assert.match(api, /IPC\.invoke\.pluginRpc/);
  assert.match(pluginIpc, /IPC\.invoke\.pluginRpc/);
});

test("dictation stays off the cloud path while the upstream host speech stack coexists", async () => {
  const [protocol, voice, errors, settingsType, dictationIpc, speechIpc] = await Promise.all([
    read("../../../packages/shared/src/protocol.ts"),
    read("../../../packages/shared/src/voice.ts"),
    read("../../../packages/shared/src/errors.ts"),
    read("../../../packages/shared/src/types/settings.ts"),
    read("../electron/main/ipc/dictation-ipc.ts"),
    read("../electron/main/ipc/speech-ipc.ts"),
  ]);
  // The 2026-10 upstream sync adopted the upstream host speech capability
  // (ADR 0281) and live voice; the fork's dictation runs on its own
  // `pi-desktop/dictation/*` domain and never touches those channels.
  assert.match(protocol, /speechTranscribe: "pi-desktop\/speech\/transcribe"/);
  assert.match(protocol, /dictationTranscribe: "pi-desktop\/dictation\/transcribe"/);
  assert.match(protocol, /dictationCancel: "pi-desktop\/dictation\/cancel"/);
  assert.doesNotMatch(voice, /VOICE_STT_SECRET_REF|sttBaseUrl|isVoiceSttConfigured/);
  assert.match(errors, /SPEECH_NOT_CONFIGURED/);
  assert.match(errors, /VOICE_NOT_CONFIGURED/);
  assert.match(settingsType, /dictation\?: VoiceSettings/);
  assert.match(speechIpc, /registerSpeechIpc/);
  void dictationIpc;
});

test("voice dictation routes through the local plugin speech adapter", async () => {
  const dictationIpc = await read("../electron/main/ipc/dictation-ipc.ts");
  assert.match(dictationIpc, /LOCAL_VOICE_PROTOCOL/);
  assert.match(dictationIpc, /runSpeechAdapter/);
  assert.doesNotMatch(dictationIpc, /getSidecar|voice\.transcribe/);
});

test("legacy cloud settings are tolerated and ignored", async () => {
  const { normalizeVoiceSettings } = await import("@pi-desktop/shared");
  assert.equal(
    normalizeVoiceSettings({ sttBaseUrl: "https://api.openai.com/v1", sttModel: "whisper-1" }),
    undefined,
  );
  assert.deepEqual(normalizeVoiceSettings({ sttBaseUrl: "https://x", language: "zh-CN" }), {
    language: "zh-CN",
  });
});
