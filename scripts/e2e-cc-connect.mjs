#!/usr/bin/env node
/**
 * CC Connect end-to-end harness (E2E-261).
 *
 * Boots a real `pi-host` (RACP bridge host) with a local OpenAI-compatible
 * stub model, then drives the cc-connect `pidesktop` backend against it:
 *
 *   authenticate + enumerate + send into an existing session
 *   streamed response observed by BOTH the external client and a desktop-side
 *     RACP subscriber at the same time
 *   approval request round trip (allow resumes the same pending turn)
 *   attachment upload through the staged attachment operations
 *   host restart: bindings + session continuity + cursor replay
 *
 * Prereqs: pnpm build:js, pnpm -C packages/agent-runtime bundle, a host-core
 * binary (PI_DESKTOP_HOST_BIN or target/debug), Go, and a cc-connect checkout
 * with the pidesktop backend (CC_CONNECT_REPO, default ~/myrepo/cc-connect).
 *
 * The real messaging platforms are intentionally not part of this harness;
 * the Go backend stands in for the platform edge (see ADR 0297 §Limitations).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RacpClient, wsClientTransport } from "../packages/racp/dist/index.js";
import { PROTOCOL_VERSION } from "../packages/shared/dist/protocol.js";
import { resolveHostBinary } from "./e2e/host.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "apps/pi-host/dist/cli.js");
const sidecar = join(root, "packages/agent-runtime/dist-bundle/sidecar.js");
const ccRepo = resolve(process.env.CC_CONNECT_REPO || join(root, "..", "cc-connect"));
const goBin = process.env.GO || "go";

for (const [label, path] of [["pi-host cli", cli], ["sidecar bundle", sidecar]]) {
  if (!existsSync(path)) {
    console.error(`${label} missing: ${path} (run pnpm build:js / bundle)`);
    process.exit(1);
  }
}
if (!existsSync(join(ccRepo, "go.mod"))) {
  console.error(`cc-connect repo missing at ${ccRepo} (set CC_CONNECT_REPO)`);
  process.exit(1);
}

let hostBinary;
try {
  hostBinary = resolveHostBinary();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const results = [];
const record = (id, ok, detail = "") => {
  results.push({ id, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}${detail ? " — " + detail : ""}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Stub OpenAI-compatible model ─────────────────────────────────────────
// APPROVE_TEST prompts get a bash tool_call (drives the approval round trip);
// after a tool result arrives the stub answers with plain text; everything
// else streams a short text reply.
const stub = { completions: 0 };
function startStubModel() {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/stats") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ completions: stub.completions }));
      return;
    }
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
      response.writeHead(404);
      response.end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      stub.completions += 1;
      let prompt = "";
      let sawToolResult = false;
      try {
        const parsed = JSON.parse(body);
        for (const message of parsed.messages ?? []) {
          if (message.role === "user") {
            prompt += typeof message.content === "string" ? message.content : JSON.stringify(message.content);
          }
          if (message.role === "tool") sawToolResult = true;
        }
      } catch {
        prompt = "";
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const chunk = (delta, finish = null) =>
        response.write(`data: ${JSON.stringify({
          id: "chatcmpl-stub",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "stub-model",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`);
      chunk({ role: "assistant" });
      if (!sawToolResult && prompt.includes("APPROVE_TEST")) {
        chunk({
          tool_calls: [{
            index: 0,
            id: "call_stub_1",
            type: "function",
            function: { name: "Bash", arguments: JSON.stringify({ command: "touch cc-connect-e2e-marker.txt && mv cc-connect-e2e-marker.txt cc-connect-e2e-marker-done.txt" }) },
          }],
        });
        chunk({}, "tool_calls");
      } else {
        for (const part of ["Hello from ", "the stub ", "model."]) chunk({ content: part });
        chunk({}, "stop");
      }
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  return new Promise((resolveListen) => {
    server.listen(0, "127.0.0.1", () => resolveListen({ server, port: server.address().port }));
  });
}

// ── pi-host lifecycle ────────────────────────────────────────────────────
let child = null;
let stderrTail = "";
function startHost(dataDir) {
  child = spawn(process.execPath, [
    cli, "--data-dir", dataDir, "--port", "0", "--host-core", hostBinary,
    "--sidecar", sidecar, "--browse-root", dataDir, "--log-level", process.env.PI_HOST_LOG_LEVEL || "warn", "--pair",
  ], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
  stderrTail = "";
  child.stderr.on("data", (chunk) => {
    stderrTail += String(chunk);
    if (process.env.DEBUG_HOST) process.stderr.write(chunk);
  });
  return new Promise((resolveReady, reject) => {
    let out = "";
    const ready = {};
    const timer = setTimeout(() => reject(new Error("pi-host did not become ready\n" + stderrTail.slice(-2000))), 90_000);
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
      for (const line of out.split("\n")) {
        if (line.startsWith("PI_HOST_READY ")) ready.info = JSON.parse(line.slice("PI_HOST_READY ".length));
        if (line.startsWith("PI_HOST_PAIRING_TOKEN ")) ready.pairing = JSON.parse(line.slice("PI_HOST_PAIRING_TOKEN ".length));
        if (line.startsWith("PI_HOST_FAILED ")) {
          clearTimeout(timer);
          reject(new Error("pi-host failed: " + line + "\n" + stderrTail.slice(-2000)));
        }
      }
      if (ready.info && ready.pairing) {
        clearTimeout(timer);
        resolveReady(ready);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`pi-host exited early code=${code}\n${stderrTail.slice(-2000)}`));
    });
  });
}

async function stopHost() {
  if (!child) return;
  const proc = child;
  child = null;
  await new Promise((resolveExit) => {
    proc.once("exit", resolveExit);
    proc.kill("SIGTERM");
    setTimeout(() => proc.kill("SIGKILL"), 5_000).unref();
  });
}

function racpClient(url, token) {
  const events = [];
  const client = new RacpClient({
    transport: wsClientTransport({ url, token }),
    client: { name: "cc-connect-harness", version: "0.15.0" },
    onEvent: (envelope) => events.push(envelope),
    requestTimeoutMs: 30_000,
  });
  return { client, events };
}

// Short-lived host-core RPC (provider seeding), same as e2e-smoke.
function hostRpcCall(dataDir, method, params) {
  return new Promise((resolveCall, rejectCall) => {
    const child2 = spawn(hostBinary, [], {
      env: { ...process.env, PI_DESKTOP_DATA_DIR: dataDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffered = "";
    const pending = new Map([
      [0, { resolve: () => {}, reject: rejectCall }],
      [1, { resolve: resolveCall, reject: rejectCall }],
    ]);
    const timer = setTimeout(() => rejectCall(new Error(`host rpc ${method} timed out`)), 30_000);
    child2.stdout.on("data", (chunk) => {
      buffered += String(chunk);
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const waiter = pending.get(message.id);
        if (!waiter) continue;
        pending.delete(message.id);
        if (message.id === 0) {
          // Handshake done; now the real call.
          child2.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n");
          continue;
        }
        clearTimeout(timer);
        child2.kill();
        if (message.error) rejectCall(new Error(`${method}: ${JSON.stringify(message.error)}`));
        else waiter.resolve(message.result);
        return;
      }
    });
    child2.once("exit", (code) => {
      clearTimeout(timer);
      rejectCall(new Error(`host-core exited early code=${code}`));
    });
    child2.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "app.handshake", params: { protocolVersion: PROTOCOL_VERSION } }) + "\n");
  });
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "cc-connect-e2e-"));
  const project = join(dataDir, "project");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "README.md"), "# cc-connect e2e project\n");
  const bindingsFile = join(dataDir, "bindings.json");

  const { server: stubServer, port: stubPort } = await startStubModel();
  let exitCode = 1;
  try {
    // Seed the stub provider before the host boots (short-lived host RPC).
    await hostRpcCall(dataDir, "providers.create", {
      name: "CC Connect Stub",
      vendorKey: "custom",
      type: "openai_compatible",
      protocol: "openai_compatible",
      baseUrl: `http://127.0.0.1:${stubPort}/v1`,
      authKind: "api_key_and_base_url",
      defaultModelId: "stub-model",
      secretValue: "stub-key-not-a-secret",
      apiStyle: "chat_completions",
    });
    record("provider-seeded", true, `stub model at http://127.0.0.1:${stubPort}/v1`);

    const ready = await startHost(dataDir);
    const url = `ws://127.0.0.1:${ready.info.port}/v1/racp/ws`;
    record("host-boots-on-loopback", ready.info.host === "127.0.0.1" && ready.info.port > 0);

    // Pair an owner device (the harness acts as the desktop side).
    const pairing = racpClient(url, ready.pairing.token);
    await pairing.client.connect();
    const paired = await pairing.client.request("connection/pair", { deviceLabel: "cc-connect harness" });
    const deviceToken = paired.deviceToken;
    record("pair-mints-owner-device", paired.roles.includes("owner"));
    await pairing.client.close();

    const owner = racpClient(url, deviceToken);
    await owner.client.connect();
    const registered = await owner.client.request("project/register", { path: project });
    const created = await owner.client.request("session/create", {
      title: "CC Connect E2E",
      projectId: registered.project.id,
      permissionMode: "ask",
    });
    const sessionId = created.session.id;
    record("session-created-with-ask-mode", created.session.permissionMode === "ask", `permissionMode=${created.session.permissionMode}`);

    // Desktop-side observer on the same session (simultaneous observation).
    await owner.client.request("events/subscribe", { scope: "session", sessionId });

    // Bindings file: conversation key → the fixed session (mode fixed).
    writeFileSync(bindingsFile, JSON.stringify({
      "e2e-key": { sessionId, mode: "fixed" },
    }, null, 2) + "\n");

    // `go test` does not forward stdin to the test binary, and the restart
    // handshake needs it: build the test binary and spawn it directly.
    const goTestBin = join(dataDir, "pidesktop-e2e.test");
    await new Promise((resolveBuild, rejectBuild) => {
      const build = spawn(goBin, ["test", "-tags", "e2e", "-c", "-o", goTestBin, "./agent/pidesktop"], {
        cwd: ccRepo,
        env: { ...process.env },
        stdio: ["ignore", "inherit", "inherit"],
      });
      build.once("exit", (code) => (code === 0 ? resolveBuild() : rejectBuild(new Error(`go test -c failed: ${code}`))));
    });
    const goArgs = ["-test.run", "TestE2EBridge", "-test.timeout", "10m", "-test.v"];
    const go = spawn(goTestBin, goArgs, {
      cwd: ccRepo,
      env: {
        ...process.env,
        CC_E2E_URL: url,
        CC_E2E_TOKEN: deviceToken,
        CC_E2E_SESSION_ID: sessionId,
        CC_E2E_PROJECT_ID: registered.project.id,
        CC_E2E_BINDINGS_FILE: bindingsFile,
        CC_E2E_DATA_DIR: dataDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let goOut = "";
    let phase1Done = false;
    let phase2Done = false;
    go.stdout.setEncoding("utf8");
    go.stdout.on("data", (chunk) => {
      goOut += chunk;
      process.stdout.write(chunk);
      if (!phase1Done && goOut.includes("PHASE1_DONE")) {
        phase1Done = true;
        void (async () => {
          record("phase1-completed", true);
          // Restart the host exactly like PI-Desktop + the daemon would.
          await stopHost();
          await sleep(500);
          const restarted = await startHost(dataDir);
          const url2 = `ws://127.0.0.1:${restarted.info.port}/v1/racp/ws`;
          record("host-restarted", restarted.info.port !== ready.info.port);
          if (url2 !== url) {
            // The URL changed with the new port; stash it for the Go phase via env? Go read
            // CC_E2E_URL at start — the harness writes the new URL to a file the test rereads
            // only through stdin "GO <url>".
            go.stdin.write(`GO ${url2}\n`);
          } else {
            go.stdin.write("GO\n");
          }
        })().catch((error) => {
          console.error("harness restart failed:", error);
          go.kill("SIGKILL");
        });
      }
      if (goOut.includes("PHASE2_DONE")) phase2Done = true;
    });
    go.stderr.on("data", (chunk) => process.stderr.write(chunk));
    const goCode = await new Promise((resolveExit) => go.once("exit", resolveExit));
    record("go-e2e-exit", goCode === 0, `exit=${goCode}`);
    if (process.env.CC_E2E_SKIP_PHASE2 === "1") {
      record("phase2-completed", true, "skipped (CC_E2E_SKIP_PHASE2)");
    } else {
      record("phase2-completed", phase2Done);
    }

    // Simultaneous observation: the harness subscriber saw everything too.
    const kinds = owner.events.map((event) => event.kind);
    record("observer-saw-stream", kinds.includes("item.delta"), kinds.join(","));
    record("observer-saw-approval", kinds.includes("approval.requested"));
    record("observer-saw-completion", kinds.includes("turn.completed"));

    if (process.env.DEBUG_EVENTS) {
      for (const envelope of owner.events) {
        if (String(envelope.kind).startsWith("item.")) {
          console.log("EVENT", envelope.kind, JSON.stringify(envelope.payload).slice(0, 400));
        }
      }
    }
    const stats = await fetch(`http://127.0.0.1:${stubPort}/stats`).then((r) => r.json());
    record("stub-model-served", stats.completions >= 3, `completions=${stats.completions}`);

    await owner.client.close();
    exitCode = results.every((r) => r.ok) ? 0 : 1;
  } catch (error) {
    console.error("HARNESS ERROR:", error?.message || error);
    exitCode = 1;
  } finally {
    await stopHost();
    stubServer.close();
    await sleep(200);
    rmSync(dataDir, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(exitCode);
}

main();
