/**
 * Real local-inference E2E for the bundled pi.local-voice plugin
 * (E2E-269, network-gated).
 *
 * The model registry is the plugin's ONLY network touchpoint and it lives
 * behind the declared HF domain allowlist; this suite skips when huggingface.co
 * is unreachable (offline CI) so it never asserts on cloud availability.
 *
 * 1) downloads whisper-tiny through the plugin's own downloader,
 * 2) transcribes a committed 16 kHz PCM WAV fixture with @huggingface/transformers,
 * 3) re-transcribes with `fetch` monkeypatched to throw, proving the
 *    transcription path itself performs zero network I/O.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(here, "..", "resources", "plugins", "pi.local-voice");

const { createDownloader } = require(join(PLUGIN_DIR, "lib", "downloader.js"));
const { createEngine } = require(join(PLUGIN_DIR, "lib", "engine.js"));

const MODEL = { id: "whisper-tiny", repoId: "Xenova/whisper-tiny" };
const DOMAINS = ["huggingface.co", "*.huggingface.co", "*.hf.co", "*.xethub.hf.co"];

async function hasNetwork() {
  try {
    await fetch("https://huggingface.co/api/models/Xenova/whisper-tiny", {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });
    return true;
  } catch {
    return false;
  }
}

/** Decode a RIFF WAVE file (PCM 16-bit) into mono Float32 samples. */
function decodeWavPcm16(buffer) {
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF");
  let offset = 12;
  let channels = 1;
  let sampleRate = 16000;
  let samples;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
    } else if (id === "data") {
      const count = Math.floor(size / 2);
      samples = new Float32Array(count);
      for (let i = 0; i < count; i += 1) samples[i] = buffer.readInt16LE(body + i * 2) / 32768;
    }
    offset = body + size + (size % 2);
  }
  if (channels > 1) {
    const mono = new Float32Array(Math.floor(samples.length / channels));
    for (let i = 0; i < mono.length; i += 1) mono[i] = samples[i * channels];
    samples = mono;
  }
  return { samples, sampleRate };
}

test("local voice: real model download and offline transcription", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-local-voice-e2e-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  const online = await hasNetwork();
  if (!online) {
    t.skip("huggingface.co is unreachable; the model registry is the only network dependency");
    return;
  }
  const modelsDir = join(dataDir, "models");
  const downloads = {};
  const downloader = createDownloader({
    domains: DOMAINS,
    models: [MODEL],
    modelsDir,
    onProgress: (modelId, progress) => {
      downloads[modelId] = progress;
    },
  });
  const engine = createEngine({ modelsDir });

  // ── download through the plugin's own allowlisted downloader ──────────
  await downloader.download(MODEL);
  assert.ok(downloads[MODEL.id].received > 0, "downloader reported progress");
  const wav = await readFile(join(here, "fixtures", "local-voice-zh.wav"));
  const { samples, sampleRate } = decodeWavPcm16(wav);
  assert.equal(sampleRate, 16000);

  // ── transcription must work with every network door locked ────────────
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => {
    throw new Error("network access attempted during local transcription");
  };

  const result = await engine.transcribe({
    repoId: MODEL.repoId,
    pcmFloat32: samples,
    sampleRate,
    language: "zh-CN",
  });
  assert.equal(typeof result.text, "string");
  assert.ok(result.text.trim().length > 0, "fixture transcribes to non-empty text");
});
