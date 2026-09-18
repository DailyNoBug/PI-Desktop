"use strict";

/**
 * Local inference engine for the pi.local-voice plugin.
 *
 * Wraps @huggingface/transformers (transformers.js v3) behind a tiny surface so
 * main.js never touches the dependency directly: the package is installed
 * on demand by `install:plugin-deps`, so "not installed" is a normal, expected
 * state that must never crash the plugin — it simply reports unavailable.
 */

const path = require("node:path");

/**
 * Reduce a BCP-47 tag to the 2-letter base language Whisper wants
 * ("zh-CN" → "zh"). Returns undefined when nothing usable remains, in which
 * case the model auto-detects the spoken language.
 */
function mapLanguage(language) {
  if (typeof language !== "string") return undefined;
  const base = language.trim().toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2}$/.test(base) ? base : undefined;
}

function createEngine({ modelsDir }) {
  // `available` is tri-state: undefined = not probed yet, then cached — the
  // require() probe is only worth paying once per plugin lifetime.
  let available;
  // One pipeline per repoId: model loading takes seconds, so a loaded model
  // must be reused across dictation requests.
  const pipelines = new Map();
  let envConfigured = false;

  function loadTransformers() {
    try {
      // Optional dependency: absent until install:plugin-deps has run.
      return require("@huggingface/transformers");
    } catch {
      return null;
    }
  }

  function configureEnv(transformers) {
    if (envConfigured) return;
    // Local-only policy: weights come exclusively from the downloaded model
    // directory, never from a remote hub at dictation time.
    transformers.env.allowLocalModels = true;
    transformers.env.allowRemoteModels = false;
    transformers.env.localModelPath = modelsDir;
    envConfigured = true;
  }

  async function getPipeline(transformers, repoId) {
    const cached = pipelines.get(repoId);
    if (cached) return cached;
    const { pipeline } = transformers;
    const task = await pipeline(
      "automatic-speech-recognition",
      path.join(modelsDir, repoId),
      { dtype: "q8" },
    );
    pipelines.set(repoId, task);
    return task;
  }

  return {
    /** True when @huggingface/transformers is requireable. Never throws. */
    isAvailable() {
      if (available === undefined) available = loadTransformers() !== null;
      return available;
    },

    /**
     * Transcribe mono 16 kHz Float32 PCM with the local model at `repoId`.
     * `language` is optional; when absent the model auto-detects it.
     */
    async transcribe({ repoId, pcmFloat32, sampleRate, language }) {
      const transformers = loadTransformers();
      if (!transformers) {
        throw new Error("local voice engine is not installed");
      }
      configureEnv(transformers);
      const recognize = await getPipeline(transformers, String(repoId));
      const options = { task: "transcribe" };
      const mapped = mapLanguage(language);
      if (mapped) options.language = mapped;
      const output = await recognize(pcmFloat32, options);
      // The pipeline returns an array only for batched input; a single
      // Float32Array yields one result object.
      const result = Array.isArray(output) ? output[0] : output;
      return { text: String(result?.text ?? "") };
    },
  };
}

module.exports = { createEngine, mapLanguage };
