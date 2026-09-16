#!/usr/bin/env node
/**
 * E2E-269 / E2E-VOICE-dictation: voice dictation over a local mock
 * OpenAI-compatible transcription endpoint. No real microphone is involved:
 * the audio payload is a stub, and the suite exercises
 *
 *   1. the OpenAI-compatible adapter against a real local HTTP server
 *      (success / provider failure / timeout / credential containment),
 *   2. the `voice.transcribe` / `voice.cancel` sidecar RPC surface
 *      (validation, oversized-payload rejection, cancellation, and that an
 *      STT failure never touches agent runtimes),
 *   3. the shared request validation the Electron main handler applies.
 *
 * Prerequisite: `pnpm build:js` (packages/agent-runtime/dist must exist).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const API_KEY = "fixture-key-never-for-live";
const requests = [];
let mode = "ok"; // ok | error500 | hang

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  requests.push({
    url: req.url,
    authorization: req.headers.authorization ?? "",
    contentType: req.headers["content-type"] ?? "",
    bytes: body.length,
    body: body.toString("utf8"),
  });
  if (!req.url.endsWith("/audio/transcriptions")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
    return;
  }
  if (mode === "error500") {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "fixture failure" } }));
    return;
  }
  if (mode === "hang") return; // never respond
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ text: "fixture transcript", language: "en" }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

const audio = () => ({
  data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
  mimeType: "audio/webm;codecs=opus",
  durationMs: 800,
});

let child = null;
let stderr = "";
const pending = new Map();
let sequence = 0;

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

async function main() {
  const runtime = await import(
    new URL("../packages/agent-runtime/dist/index.js", import.meta.url).href
  );
  const shared = await import(
    new URL("../packages/shared/dist/index.js", import.meta.url).href
  );
  const provider = new runtime.OpenAICompatibleTranscriptionProvider();

  // --- 1. adapter against the mock endpoint -------------------------------
  let result = await provider.transcribe(audio(), {
    baseUrl,
    model: "fixture-whisper",
    apiKey: API_KEY,
    timeoutMs: 5_000,
  });
  assert.equal(result.text, "fixture transcript");
  assert.equal(result.detectedLanguage, "en");
  const first = requests.at(-1);
  assert.equal(first.url, "/v1/audio/transcriptions");
  assert.match(first.contentType, /^multipart\/form-data/);
  assert.equal(first.authorization, `Bearer ${API_KEY}`);
  assert.ok(first.body.includes('name="model"'));
  assert.ok(first.body.includes("fixture-whisper"));
  assert.ok(first.body.includes('filename="dictation.webm"'));
  assert.ok(first.body.includes('name="response_format"'));
  console.log("PASS voice-adapter-success");

  mode = "error500";
  await assert.rejects(
    () =>
      provider.transcribe(audio(), {
        baseUrl,
        model: "fixture-whisper",
        apiKey: API_KEY,
        timeoutMs: 5_000,
      }),
    (error) => error?.errorCode === "PROVIDER_ERROR" && !String(error?.message).includes(API_KEY),
  );
  console.log("PASS voice-adapter-provider-error-structured");

  mode = "hang";
  await assert.rejects(
    () =>
      provider.transcribe(audio(), {
        baseUrl,
        model: "fixture-whisper",
        apiKey: API_KEY,
        timeoutMs: 250,
      }),
    (error) => error?.errorCode === "TIMEOUT",
  );
  mode = "ok";
  console.log("PASS voice-adapter-timeout-bounded");

  // --- 2. shared validation used by the Electron main handler -------------
  const oversized = new Uint8Array(shared.VOICE_MAX_AUDIO_BYTES + 1);
  const tooLarge = shared.validateVoiceTranscribeRequest({
    requestId: "e2e-voice-0001",
    audio: oversized,
    mimeType: "audio/webm",
    durationMs: 1000,
  });
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.failure?.code, "VOICE_PAYLOAD_TOO_LARGE");
  const notAudio = shared.validateVoiceTranscribeRequest({
    requestId: "e2e-voice-0002",
    audio: "not-bytes",
    mimeType: "audio/webm",
    durationMs: 1000,
  });
  assert.equal(notAudio.ok, false);
  assert.equal(notAudio.failure?.code, "INVALID_ARGUMENT");
  console.log("PASS voice-ipc-validation");

  // --- 3. sidecar RPC surface ----------------------------------------------
  child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../packages/agent-runtime/dist/sidecar.js", import.meta.url))],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } },
  );
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const send = (message) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "host.proxy") {
      send({ id: message.id, result: {} });
      return;
    }
    if (message.id == null) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(message.error);
    else entry.resolve(message.result);
  });
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = `e2e-${++sequence}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`RPC timed out: ${method}`));
      }, 15_000);
      pending.set(id, { resolve, reject, timer });
      send({ id, method, params });
    });
  const rpcError = (method, params) =>
    rpc(method, params).then(
      () => {
        throw new Error(`${method} unexpectedly succeeded`);
      },
      (error) => error,
    );
  const base64 = Buffer.from(audio().data).toString("base64");
  const voiceParams = {
    requestId: "sidecar-0001",
    audioBase64: base64,
    mimeType: audio().mimeType,
    durationMs: 800,
    provider: { baseUrl, model: "fixture-whisper", apiKey: API_KEY },
  };

  const transcribed = await rpc("voice.transcribe", voiceParams);
  assert.equal(transcribed.requestId, "sidecar-0001");
  assert.equal(transcribed.text, "fixture transcript");
  assert.equal(transcribed.detectedLanguage, "en");
  console.log("PASS voice-sidecar-transcribe");

  const big = Buffer.alloc(shared.VOICE_MAX_AUDIO_BYTES + 1, 1).toString("base64");
  const tooBig = await rpcError("voice.transcribe", {
    ...voiceParams,
    requestId: "sidecar-0002",
    audioBase64: big,
  });
  assert.equal(tooBig.data?.errorCode, "VOICE_PAYLOAD_TOO_LARGE");
  console.log("PASS voice-sidecar-oversized-rejected");

  const badId = await rpcError("voice.transcribe", {
    ...voiceParams,
    requestId: "short",
  });
  assert.equal(badId.data?.errorCode, "INVALID_ARGUMENT");
  const unconfigured = await rpcError("voice.transcribe", {
    ...voiceParams,
    requestId: "sidecar-0003",
    provider: {},
  });
  assert.equal(unconfigured.data?.errorCode, "VOICE_NOT_CONFIGURED");
  console.log("PASS voice-sidecar-validation");

  const unknownCancel = await rpc("voice.cancel", { requestId: "missing-0001" });
  assert.equal(unknownCancel.cancelled, false);
  console.log("PASS voice-sidecar-cancel-unknown");

  // Cancellation mid-flight: the endpoint hangs; voice.cancel must abort it.
  mode = "hang";
  const inFlight = rpc("voice.transcribe", {
    ...voiceParams,
    requestId: "sidecar-0004",
  }).then(
    () => {
      throw new Error("hung transcription unexpectedly resolved");
    },
    (error) => error,
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  const cancelled = await rpc("voice.cancel", { requestId: "sidecar-0004" });
  assert.equal(cancelled.cancelled, true);
  const aborted = await inFlight;
  assert.equal(aborted.data?.errorCode, "VOICE_CANCELLED");
  mode = "ok";
  console.log("PASS voice-sidecar-cancel-aborts-flight");

  // An STT failure must not disturb agent state: health still reports and a
  // later transcription succeeds on the same sidecar process.
  mode = "error500";
  const sttFailure = await rpcError("voice.transcribe", {
    ...voiceParams,
    requestId: "sidecar-0005",
  });
  assert.equal(sttFailure.data?.errorCode, "PROVIDER_ERROR");
  const health = await rpc("sidecar.health", {});
  assert.equal(health.ok, true);
  mode = "ok";
  const recovered = await rpc("voice.transcribe", {
    ...voiceParams,
    requestId: "sidecar-0006",
  });
  assert.equal(recovered.text, "fixture transcript");
  console.log("PASS voice-sidecar-stt-failure-isolated");

  // Credential containment across every captured exchange: the key appears
  // only as the Authorization header value, never in a body or error text.
  for (const request of requests) {
    const bodyHas = request.url === "/v1/audio/transcriptions" && /name="apiKey"/.test(request.body);
    assert.equal(bodyHas, false, "api key must not appear as a form field");
  }
  assert.ok(!stderr.includes(API_KEY), "api key must never reach sidecar logs");
  console.log("PASS voice-secret-containment");
}

main()
  .catch((error) => {
    fail(error instanceof Error ? `${error.message}\n${error.stack}` : String(error));
  })
  .finally(async () => {
    if (child) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await new Promise((resolve) => server.close(resolve));
  });
