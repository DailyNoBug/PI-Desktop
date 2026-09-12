import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "../../..");
const read = (path) => readFile(join(root, path), "utf8");

test("remote SSH channels are typed, allowlisted, and renderer-facing", async () => {
  const [protocol, api, preload] = await Promise.all([
    read("packages/shared/src/protocol.ts"),
    read("apps/desktop/src/lib/api.ts"),
    read("apps/desktop/electron/preload/index.ts"),
  ]);
  for (const [channel, fn] of [
    ["remoteListConnections", "listRemoteConnections"],
    ["remoteRefreshConnections", "refreshRemoteConnections"],
    ["remoteTestConnection", "testRemoteConnection"],
    ["remoteAddConnection", "addRemoteConnection"],
    ["remoteUpdateConnection", "updateRemoteConnection"],
    ["remoteRemoveConnection", "removeRemoteConnection"],
    ["remoteConnect", "connectRemote"],
    ["remoteDisconnect", "disconnectRemote"],
    ["remoteDiagnostics", "remoteDiagnostics"],
    ["remoteImportProvider", "importRemoteProvider"],
    ["remoteDeleteProvider", "deleteRemoteProvider"],
    ["remoteListProjects", "listRemoteProjects"],
    ["remoteAddProject", "addRemoteProject"],
    ["remoteOpenProject", "openRemoteProject"],
    ["remoteRemoveProject", "removeRemoteProject"],
    ["remoteBrowseDirectory", "browseRemoteDirectory"],
  ]) {
    assert.match(protocol, new RegExp(`${channel}: "pi-desktop/remote/`));
    assert.match(api, new RegExp(`${fn}:`));
  }
  assert.match(protocol, /remoteChanged: "pi-desktop\/remote\/event\/changed"/);
  assert.match(api, /onRemoteChanged/);
  assert.match(preload, /IPC_WHITELIST/);
});

test("SSH lifecycle stays in Electron Main and never exposes keys to the renderer", async () => {
  const [manager, ssh, api, main] = await Promise.all([
    read("apps/desktop/electron/main/remote-manager.ts"),
    read("apps/desktop/electron/main/ssh.ts"),
    read("apps/desktop/src/lib/api.ts"),
    read("apps/desktop/electron/main/index.ts"),
  ]);
  assert.match(manager, /class RemoteManager/);
  assert.match(manager, /secrets\.set/);
  assert.match(manager, /secrets\.getForRuntime/);
  assert.match(manager, /onAudit\("ssh\.host_key\.accepted"/);
  assert.match(manager, /onAudit\("remote\.pairing\.created"/);
  assert.match(manager, /onAudit\("remote\.permission\.decision"/);
  assert.doesNotMatch(manager, /from "electron"/);
  assert.doesNotMatch(api, /child_process|node:child_process|ssh-spawn|privateKey/);
  assert.match(ssh, /resolveSshExecutable/);
  assert.match(ssh, /BatchMode=yes/);
  assert.match(ssh, /ExitOnForwardFailure=yes/);
  assert.match(ssh, /127\.0\.0\.1:\$\{localPort\}:127\.0\.0\.1:\$\{remotePort\}/);
  assert.match(main, /new RemoteManager|RemoteManager\.open/);
  assert.doesNotMatch(ssh, /StrictHostKeyChecking=no/);
});

test("connection metadata is durable but token material is not serialized", async () => {
  const store = await read("apps/desktop/electron/main/remote-store.ts");
  assert.match(store, /remote-ssh\.json/);
  assert.match(store, /mode: 0o600/);
  assert.match(store, /RemoteHostRuntime/);
  assert.match(store, /RemoteProjectRecord/);
  assert.doesNotMatch(store, /deviceToken|pairingToken/);
});
