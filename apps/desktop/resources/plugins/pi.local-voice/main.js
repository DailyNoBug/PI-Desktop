"use strict";

/**
 * Local Voice — bundled first-party speech-to-text plugin.
 *
 * Registers the `pi.local_voice` speech adapter (mono 16 kHz PCM in, text out)
 * and a small management rpc (`status`, `models.*`) the settings UI uses to
 * download and manage on-device Whisper models. Everything runs locally: model
 * weights are fetched once from the Hugging Face Hub allowlist declared in the
 * manifest and are then used strictly offline.
 */

const fs = require("node:fs");
const path = require("node:path");
const { createDownloader, REQUIRED_FILES } = require("./lib/downloader");
const { createEngine } = require("./lib/engine");

/** Must match packages/shared/src/voice.ts LOCAL_VOICE_PROTOCOL. */
const PROTOCOL_ID = "pi.local_voice";
/** Host allowlist for model downloads; mirrors manifest.net.domains. */
const NET_DOMAINS = [
  "huggingface.co",
  "*.huggingface.co",
  "*.hf.co",
  "*.xethub.hf.co",
];

const MODEL_CATALOG = [
  {
    id: "whisper-tiny",
    repoId: "Xenova/whisper-tiny",
    label: "Whisper Tiny (multilingual)",
    sizeApproxMB: 45,
  },
  {
    id: "whisper-base",
    repoId: "Xenova/whisper-base",
    label: "Whisper Base (multilingual)",
    sizeApproxMB: 85,
  },
  {
    id: "whisper-small",
    repoId: "Xenova/whisper-small",
    label: "Whisper Small (multilingual)",
    sizeApproxMB: 250,
  },
];

const STATE_FILE = "state.json";
const MODELS_DIR_NAME = "models";
/** RMS level below which dictation audio is treated as silence. */
const RMS_SILENCE_THRESHOLD = 0.0015;
const INPUT_SAMPLE_RATE = 16000;

let dataPath = "";
let modelsDir = "";
/** Persisted plugin state: { activeModel: <model id> | null }. */
let state = { activeModel: null };
let engine = null;
let downloader = null;
/** Live download tasks: modelId → { state: "running"|"error", error?, received, total }. */
const downloads = new Map();

function findModel(id) {
  return MODEL_CATALOG.find((model) => model.id === id) ?? null;
}

/** A model counts as installed only when every required file is on disk. */
function isInstalled(model) {
  if (!model) return false;
  try {
    return REQUIRED_FILES.every((file) =>
      fs.existsSync(path.join(modelsDir, model.repoId, file)),
    );
  } catch {
    // existsSync can only throw on malformed arguments; treat as absent.
    return false;
  }
}

function installedModels() {
  return MODEL_CATALOG.filter((model) => isInstalled(model));
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataPath, STATE_FILE), "utf8"));
    const activeModel =
      typeof raw?.activeModel === "string" && findModel(raw.activeModel)
        ? raw.activeModel
        : null;
    return { activeModel };
  } catch {
    // Missing or corrupt state is the normal first-run condition.
    return { activeModel: null };
  }
}

/** Persist state atomically: temp file + rename, so a crash cannot truncate it. */
function saveState() {
  const target = path.join(dataPath, STATE_FILE);
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ activeModel: state.activeModel }, null, 2)}\n`);
  fs.renameSync(temp, target);
}

function isReady() {
  const active = findModel(state.activeModel);
  return Boolean(active && isInstalled(active) && engine && engine.isAvailable());
}

function statusSnapshot() {
  const models = MODEL_CATALOG.map((model) => ({
    id: model.id,
    installed: isInstalled(model),
    active: state.activeModel === model.id,
  }));
  const downloadsOut = {};
  for (const [id, entry] of downloads) {
    downloadsOut[id] = {
      state: entry.state,
      ...(entry.error ? { error: entry.error } : {}),
      received: entry.received,
      total: entry.total,
    };
  }
  return {
    ready: isReady(),
    activeModel: state.activeModel ?? null,
    engineAvailable: Boolean(engine && engine.isAvailable()),
    models,
    downloads: downloadsOut,
  };
}

function listModels() {
  return {
    models: MODEL_CATALOG.map((model) => ({
      id: model.id,
      label: model.label,
      repoId: model.repoId,
      sizeApproxMB: model.sizeApproxMB,
      installed: isInstalled(model),
      active: state.activeModel === model.id,
    })),
  };
}

/** Fold downloader progress into the live task entry shown by `status`. */
function trackProgress(modelId, progress) {
  const entry = downloads.get(modelId);
  if (!entry || entry.state !== "running") return;
  entry.received = progress.received;
  entry.total = progress.total;
}

/**
 * Start a download task without awaiting it; completion and failure are
 * observed through the `status` rpc. Never throws for bad input — only an
 * unknown model id is a caller bug worth surfacing as an error.
 */
function startDownload(params) {
  const id = String(params?.id ?? "");
  const model = findModel(id);
  if (!model) throw new Error(`unknown model id: ${id}`);
  if (downloads.has(id) && downloads.get(id).state === "running") {
    return { started: false, reason: "already-running" };
  }
  if (isInstalled(model)) {
    return { started: false, reason: "already-installed" };
  }
  downloads.set(id, { state: "running", error: undefined, received: 0, total: 0 });
  console.log(`[pi.local-voice] downloading model ${model.repoId}`);

  downloader
    .download(model)
    .then(() => {
      downloads.delete(id);
      // The first downloaded model becomes active on its own so dictation
      // works right away instead of requiring a separate activation step.
      const activeModel = findModel(state.activeModel);
      if (!activeModel || !isInstalled(activeModel)) {
        state.activeModel = model.id;
        try {
          saveState();
        } catch (error) {
          console.log(`[pi.local-voice] failed to persist state: ${error?.message ?? error}`);
        }
      }
      console.log(`[pi.local-voice] model ${model.repoId} ready`);
    })
    .catch((error) => {
      const previous = downloads.get(id);
      downloads.set(id, {
        state: "error",
        error: String(error?.message ?? error),
        received: previous?.received ?? 0,
        total: previous?.total ?? 0,
      });
      console.log(`[pi.local-voice] download failed: ${error?.message ?? error}`);
    });

  return { started: true };
}

function removeModel(params) {
  const id = String(params?.id ?? "");
  const model = findModel(id);
  if (!model) throw new Error(`unknown model id: ${id}`);
  const running = downloads.get(id);
  if (running && running.state === "running") {
    // Deleting the directory under a live download would race the writer.
    return { ok: false, reason: "downloading" };
  }
  downloads.delete(id);
  if (!isInstalled(model)) {
    return { ok: false, reason: "not-installed" };
  }
  const othersInstalled = installedModels().some((entry) => entry.id !== id);
  if (state.activeModel === id && othersInstalled) {
    // The active model stays while an alternative exists; the UI should
    // switch models first.
    return { ok: false, reason: "active" };
  }
  try {
    fs.rmSync(path.join(modelsDir, model.repoId), { recursive: true, force: true });
  } catch (error) {
    return { ok: false, reason: "error", error: String(error?.message ?? error) };
  }
  if (state.activeModel === id) {
    state.activeModel = null;
    try {
      saveState();
    } catch (error) {
      console.log(`[pi.local-voice] failed to persist state: ${error?.message ?? error}`);
    }
  }
  return { ok: true };
}

function setActiveModel(params) {
  const id = String(params?.id ?? "");
  const model = findModel(id);
  if (!model) throw new Error(`unknown model id: ${id}`);
  if (!isInstalled(model)) {
    return { ok: false, reason: "not-installed" };
  }
  state.activeModel = id;
  try {
    saveState();
  } catch (error) {
    return { ok: false, reason: "error", error: String(error?.message ?? error) };
  }
  return { ok: true, ready: isReady() };
}

/** Decode base64 mono 16-bit little-endian PCM into normalized Float32 samples. */
function decodePcm16LE(base64) {
  const buffer = Buffer.from(String(base64 ?? ""), "base64");
  // Floor to whole samples: a truncated trailing byte would decode as garbage.
  const sampleCount = Math.floor(buffer.length / 2);
  const samples = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = buffer.readInt16LE(index * 2) / 32768;
  }
  return samples;
}

/** Root-mean-square amplitude, used as a cheap silence gate before inference. */
function rms(samples) {
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    sum += samples[index] * samples[index];
  }
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

async function handleSpeech(input) {
  if (!engine || !engine.isAvailable()) {
    throw new Error("local voice engine is not installed");
  }
  const model = findModel(state.activeModel);
  if (!model || !isInstalled(model)) {
    throw new Error("local voice model is not downloaded");
  }
  const samples = decodePcm16LE(input?.audio);
  if (rms(samples) < RMS_SILENCE_THRESHOLD) {
    throw new Error("no speech detected");
  }
  const language =
    typeof input?.language === "string" && input.language ? input.language : undefined;
  const { text } = await engine.transcribe({
    repoId: model.repoId,
    pcmFloat32: samples,
    sampleRate: INPUT_SAMPLE_RATE,
    language,
  });
  return { kind: "text", text: String(text ?? "").trim() };
}

/** Renderer→plugin management rpc; results must stay JSON-serializable. */
async function handleRpc(method, params) {
  switch (method) {
    case "status":
      return statusSnapshot();
    case "models.list":
      return listModels();
    case "models.download":
      return startDownload(params);
    case "models.remove":
      return removeModel(params);
    case "models.setActive":
      return setActiveModel(params);
    default:
      throw new Error(`unknown rpc method: ${method}`);
  }
}

async function onLoad() {
  dataPath = await pi.plugin.getDataPath();
  // The data path is host-provided; it exists only after we create it.
  fs.mkdirSync(dataPath, { recursive: true });
  modelsDir = path.join(dataPath, MODELS_DIR_NAME);
  fs.mkdirSync(modelsDir, { recursive: true });
  state = loadState();

  engine = createEngine({ modelsDir });
  downloader = createDownloader({
    domains: NET_DOMAINS,
    models: MODEL_CATALOG,
    modelsDir,
    onProgress: trackProgress,
  });

  await pi.speech.registerAdapter({
    protocol: PROTOCOL_ID,
    label: "Local Voice",
    roles: ["transcribe"],
    handle: handleSpeech,
  });
  try {
    await pi.rpc.register(handleRpc);
  } catch (error) {
    // Do not leave a half-registered plugin behind when rpc fails.
    await pi.speech.unregisterAdapter(PROTOCOL_ID).catch(() => {});
    throw error;
  }
}

async function onUnload() {
  // Both cleanups are best-effort: unload must never fail because the host
  // side may already have dropped its registry entry.
  try {
    await pi.rpc.unregister();
  } catch (error) {
    console.log(`[pi.local-voice] rpc unregister failed: ${error?.message ?? error}`);
  }
  try {
    await pi.speech.unregisterAdapter(PROTOCOL_ID);
  } catch (error) {
    console.log(`[pi.local-voice] adapter unregister failed: ${error?.message ?? error}`);
  }
}

module.exports = { onLoad, onUnload };
