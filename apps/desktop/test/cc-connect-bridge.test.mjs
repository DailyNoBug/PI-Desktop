import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { buildHost } = await import("@pi-desktop/racp/test-harness");
const { DeviceTokenAuthenticator, MemoryCredentialStore, RacpClient, wsClientTransport } = await import("@pi-desktop/racp");
const { IPC } = await import("@pi-desktop/shared");
const { createRacpBridge } = await import("../electron/main/bootstrap/racp-bridge.ts");
const { createCcConnectController } = await import("../electron/main/services/cc-connect-controller.ts");

const { MemoryCredentialStore: _unused } = { MemoryCredentialStore: null };
void _unused;

test("racp bridge serves the host on loopback with scoped roles and clean discovery files", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cc-bridge-"));
  try {
    const store = new MemoryCredentialStore();
    const { host } = buildHost();
    const log = () => undefined;
    const invocations = [];
    const bridge = createRacpBridge({
      dataDir,
      version: "0.0.0-test",
      agentHost: host,
      getHost: () => ({ call: async () => ({}) }),
      invoke: async (channel, args) => {
        invocations.push({ channel, args });
        return {};
      },
      channels: IPC.invoke,
      isSessionBusy: () => false,
      credentialStore: store,
      log,
    });

    const status = await bridge.start();
    assert.equal(status.running, true);
    assert.ok(status.host === "127.0.0.1", "bridge binds loopback");
    assert.ok(status.port > 0);
    assert.ok(status.url?.startsWith("ws://127.0.0.1:"));

    // Discovery file exists, is JSON, and never contains the raw token.
    const discovery = JSON.parse(await readFile(bridge.discoveryFile, "utf8"));
    assert.equal(discovery.url, status.url);
    const token = (await readFile(bridge.tokenFile, "utf8")).trim();
    assert.ok(token.length > 16);
    assert.equal(JSON.stringify(discovery).includes(token), false, "discovery file must not carry the token");
    const tokenMode = (await stat(bridge.tokenFile)).mode & 0o777;
    assert.equal(tokenMode, 0o600, "token file is owner-only");

    // The minted device authenticates with viewer/controller/approver roles.
    const auth = await new DeviceTokenAuthenticator(store).authenticate({
      authorization: `Bearer ${token}`,
      urlHasToken: false,
      connectionId: "probe",
    });
    assert.ok(auth);
    for (const role of ["viewer", "controller", "approver"]) {
      assert.ok(auth.principal.roles.includes(role), `bridge device has ${role}`);
    }
    assert.equal(auth.principal.roles.includes("owner"), false, "bridge device must never be owner");

    // A real RACP client can initialize; a wrong token is refused.
    const client = new RacpClient({
      transport: wsClientTransport({ url: status.url, token }),
      client: { name: "cc-connect-e2e", version: "0.0.0-test" },
      requestTimeoutMs: 5000,
    });
    const init = await client.connect();
    assert.ok(init.principal.roles.includes("controller"));

    const bad = new RacpClient({
      transport: wsClientTransport({ url: status.url, token: `${token.slice(0, -2)}xx` }),
      client: { name: "cc-connect-e2e", version: "0.0.0-test" },
      requestTimeoutMs: 5000,
    });
    await assert.rejects(() => bad.connect(), /unauthorized|auth|401|refused|REMOTE/i);

    await client.close();

    await bridge.stop();
    await assert.rejects(() => readFile(bridge.discoveryFile, "utf8"), /ENOENT/, "discovery file is removed on stop");
    // Stopping twice is safe.
    await bridge.stop();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("cc-connect controller manages daemon lifecycle with redacted logs", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cc-controller-"));
  const workDir = await mkdtemp(join(tmpdir(), "cc-controller-bin-"));
  try {
    const { host } = buildHost();
    const store = new MemoryCredentialStore();
    const controller = createCcConnectController({
      dataDir,
      version: "0.0.0-test",
      agentHost: host,
      getHost: () => ({ call: async () => ({}) }),
      invoke: async () => ({}),
      channels: IPC.invoke,
      isSessionBusy: () => false,
      credentialStore: store,
      log: () => undefined,
    });

    // Bridge enablement persists and survives a fresh controller.
    const enabled = await controller.setBridgeEnabled(true);
    assert.equal(enabled.bridge.enabled, true);
    assert.equal(enabled.bridge.running, true);

    // A fake daemon prints a token-looking line and stays alive.
    const fakeBin = join(workDir, "fake-cc-connect.mjs");
    await writeFile(
      fakeBin,
      "console.log('pdt1.supersecret-token-value');\nsetInterval(() => console.log('tick'), 50);\n",
      "utf8",
    );
    const started = await controller.startProcess({ command: process.execPath, args: [fakeBin] });
    assert.equal(started.running, true);

    await new Promise((resolve) => setTimeout(resolve, 250));
    const logs = await controller.logs({ limit: 50 });
    const joined = logs.lines.join("\n");
    assert.ok(joined.includes("tick"), "daemon output is captured");
    assert.equal(joined.includes("supersecret-token-value"), false, "token-looking strings are redacted");
    assert.ok(joined.includes("[redacted]"), "redaction marker is present");

    const stopped = await controller.stopProcess();
    assert.equal(stopped.running, false);

    const status = await controller.status();
    assert.equal(status.bridge.enabled, true);
    assert.equal(status.process.running, false);

    await controller.setBridgeEnabled(false);
    const disabled = await controller.status();
    assert.equal(disabled.bridge.enabled, false);
    assert.equal(disabled.bridge.running, false);

    await controller.dispose();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
});
