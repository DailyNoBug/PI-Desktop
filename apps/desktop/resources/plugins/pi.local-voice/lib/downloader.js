"use strict";

/**
 * Model downloader for the pi.local-voice plugin.
 *
 * Downloads the exact file set transformers.js needs to run a Whisper model
 * fully offline from the Hugging Face Hub. Redirects are followed by hand so
 * every hop — not just the first URL — is checked against the plugin's
 * `manifest.net.domains` allowlist before any bytes are requested.
 */

const fs = require("node:fs");
const path = require("node:path");

/** Files required for local quantized CPU inference from a Xenova Whisper repo. */
const REQUIRED_FILES = [
  "config.json",
  "generation_config.json",
  "preprocessor_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/encoder_model_quantized.onnx",
  "onnx/decoder_model_merged_quantized.onnx",
];

/** Redirect statuses that carry a `Location` header. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Safety ceiling: same hop budget the host uses for `pi.net.fetch`. */
const MAX_REDIRECTS = 5;
/** Progress callbacks are throttled to this interval; file start/end always emit. */
const PROGRESS_INTERVAL_MS = 250;

/**
 * Match one allowlist entry against a hostname. `*.suffix` entries admit the
 * suffix itself and any subdomain; bare entries admit that exact host only.
 * This mirrors `isNetHostAllowed` in packages/plugin-sdk/src/net-policy.ts so
 * the plugin never requests a host the manifest does not declare.
 */
function matchesDomain(host, pattern) {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === pattern;
}

/**
 * Throw unless `url` is an https URL whose host is covered by `domains`.
 * Exported for unit tests; every request and redirect in this module goes
 * through it.
 */
function assertAllowedHost(url, domains) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new Error(`invalid download url: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`only https downloads are allowed: ${url}`);
  }
  const host = parsed.hostname.trim().toLowerCase().replace(/\.$/, "");
  const allowed = (Array.isArray(domains) ? domains : []).some((entry) => {
    if (typeof entry !== "string") return false;
    return matchesDomain(host, entry.trim().toLowerCase());
  });
  if (!allowed) {
    throw new Error(`host is not in the plugin net allowlist: ${host}`);
  }
  return host;
}

/** Fetch `url` while following redirects manually, re-checking every hop. */
async function fetchFollowingRedirects(url, domains) {
  let current = String(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    assertAllowedHost(current, domains);
    const response = await fetch(current, { redirect: "manual" });
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`redirect without location from ${current}`);
      }
      current = new URL(location, current).toString();
      continue;
    }
    return response;
  }
  throw new Error(`too many redirects while downloading ${url}`);
}

/**
 * Stream one response body to `targetPath` via a `<file>.part` temp file.
 * `onBytes(received, declared)` fires as bytes land so the caller can compute
 * progress; `declared` is 0 when Content-Length is absent (chunked transfers).
 */
async function streamToFile(response, targetPath, onBytes) {
  const partPath = `${targetPath}.part`;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const declared = Number(response.headers.get("content-length")) || 0;
  const output = fs.createWriteStream(partPath);
  let received = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (!output.write(value)) {
        // Backpressure: wait for the drain event instead of buffering the
        // whole model in memory. Listeners are detached on settle so a long
        // download cannot pile up one "error" listener per chunk.
        await new Promise((resolve, reject) => {
          const onDrain = () => {
            cleanup();
            resolve();
          };
          const onError = (error) => {
            cleanup();
            reject(error);
          };
          const cleanup = () => {
            output.removeListener("drain", onDrain);
            output.removeListener("error", onError);
          };
          output.once("drain", onDrain);
          output.once("error", onError);
        });
      }
      onBytes(received, declared);
    }
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      output.once("error", onError);
      output.end(() => {
        output.removeListener("error", onError);
        resolve();
      });
    });
    fs.renameSync(partPath, targetPath);
  } catch (error) {
    // A partial file must never look complete: best-effort cleanup, then the
    // error propagates to mark the download task as failed.
    output.destroy();
    try {
      fs.rmSync(partPath, { force: true });
    } catch {
      // Ignored: the task error is the signal that matters.
    }
    throw error;
  }
}

/**
 * Create a downloader bound to one models directory and allowlist.
 *
 * `models` is the catalog (id → model descriptor) so `download` accepts either
 * a model id or a descriptor object. `onProgress(modelId, { received, total,
 * file })` is throttled to one call per 250ms per file, plus one at the start
 * and one at the completion of each file.
 */
function createDownloader({ domains, models, modelsDir, onProgress }) {
  const catalog = new Map(
    (Array.isArray(models) ? models : []).map((model) => [model.id, model]),
  );
  const report = typeof onProgress === "function" ? onProgress : () => {};

  function resolveModel(model) {
    if (model && typeof model === "object" && typeof model.repoId === "string") {
      return model;
    }
    return catalog.get(String(model ?? ""));
  }

  async function downloadFile(repoId, file, counters, modelId) {
    const url = `https://huggingface.co/${repoId}/resolve/main/${file}`;
    const targetPath = path.join(modelsDir, repoId, file);
    const response = await fetchFollowingRedirects(url, domains);
    if (!response.ok) {
      throw new Error(`${file}: HTTP ${response.status}`);
    }
    const fileDeclared =
      Number(response.headers.get("content-length")) || 0;
    let lastEmit = 0;
    let fileReceived = 0;
    // Emit once at file start so the UI can name the current file immediately.
    report(modelId, { received: counters.received, total: counters.total, file });
    await streamToFile(response, targetPath, (received, declared) => {
      fileReceived = received;
      const receivedTotal = counters.received + received;
      // Without Content-Length the total lags at "received so far" so progress
      // still advances instead of dividing by zero.
      const total = declared > 0 ? counters.total + declared : receivedTotal;
      const now = Date.now();
      if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
        lastEmit = now;
        report(modelId, { received: receivedTotal, total, file });
      }
    });
    // Count the bytes that actually landed: a missing Content-Length must not
    // leave the running total stuck at zero.
    counters.received += fileReceived;
    counters.total += fileDeclared > 0 ? fileDeclared : fileReceived;
    // Emit once at file completion with the settled counters.
    report(modelId, { received: counters.received, total: counters.total, file });
  }

  async function download(model) {
    const entry = resolveModel(model);
    if (!entry) {
      throw new Error(`unknown model: ${JSON.stringify(model)}`);
    }
    const counters = { received: 0, total: 0 };
    for (const file of REQUIRED_FILES) {
      await downloadFile(entry.repoId, file, counters, entry.id);
    }
    return { received: counters.received, total: counters.total };
  }

  return { download };
}

module.exports = { createDownloader, assertAllowedHost, REQUIRED_FILES };
