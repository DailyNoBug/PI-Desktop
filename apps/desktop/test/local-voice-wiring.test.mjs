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

test("cloud speech is fully removed from the codebase", async () => {
  const [protocol, voice, errors, settingsType] = await Promise.all([
    read("../../../packages/shared/src/protocol.ts"),
    read("../../../packages/shared/src/voice.ts"),
    read("../../../packages/shared/src/errors.ts"),
    read("../../../packages/shared/src/types/settings.ts"),
  ]);
  assert.doesNotMatch(protocol, /pi-desktop\/speech\//);
  assert.doesNotMatch(voice, /VOICE_STT_SECRET_REF|sttBaseUrl|isVoiceSttConfigured/);
  assert.doesNotMatch(errors, /SPEECH_NOT_CONFIGURED|SPEECH_INPUT_TOO_LARGE/);
  assert.doesNotMatch(settingsType, /SpeechSettings/);
});

test("voice dictation routes through the local plugin speech adapter", async () => {
  const voiceIpc = await read("../electron/main/ipc/voice-ipc.ts");
  assert.match(voiceIpc, /LOCAL_VOICE_PROTOCOL/);
  assert.match(voiceIpc, /runSpeechAdapter/);
  assert.doesNotMatch(voiceIpc, /getSidecar|voice\.transcribe/);
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
