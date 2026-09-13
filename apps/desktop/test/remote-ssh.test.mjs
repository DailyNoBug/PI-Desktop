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
  assert.match(main, /setAsDefaultProtocolClient\("pi-desktop"\)/);
  assert.match(main, /app\.on\("open-url"/);
  assert.match(main, /app\.on\("second-instance"/);
  assert.doesNotMatch(ssh, /StrictHostKeyChecking=no/);
});

test("remote deep links are packaged and confirmed in Main", async () => {
  const [main, parser, desktopPackage] = await Promise.all([
    read("apps/desktop/electron/main/index.ts"),
    read("apps/desktop/electron/main/deep-link.ts"),
    read("apps/desktop/package.json"),
  ]);
  assert.match(main, /runDeepLink/);
  assert.match(main, /dialog\.showMessageBox/);
  assert.match(parser, /parsePiDesktopDeepLink/);
  assert.match(parser, /segment === "\." \|\| segment === "\.\."/);
  assert.match(desktopPackage, /"schemes": \[\s*"pi-desktop"\s*\]/);
});

test("connection metadata is durable but token material is not serialized", async () => {
  const store = await read("apps/desktop/electron/main/remote-store.ts");
  assert.match(store, /remote-ssh\.json/);
  assert.match(store, /mode: 0o600/);
  assert.match(store, /RemoteHostRuntime/);
  assert.match(store, /RemoteProjectRecord/);
  assert.doesNotMatch(store, /deviceToken|pairingToken/);
});

test("remote MCP management and execution stay on the remote Host", async () => {
  const [manager, main, piHost, renderer] = await Promise.all([
    read("apps/desktop/electron/main/remote-manager.ts"),
    read("apps/desktop/electron/main/index.ts"),
    read("packages/pi-host/src/pi-host.ts"),
    read("apps/desktop/src/components/settings/AgentMcpPage.tsx"),
  ]);
  for (const operation of [
    "mcp/list",
    "mcp/upsert",
    "mcp/remove",
    "mcp/setEnabled",
    "mcp/setScope",
    "mcp/test",
  ]) {
    assert.match(manager, new RegExp(`"${operation}"`));
  }
  assert.match(main, /function remoteMcpContext/);
  for (const method of ["listMcp", "upsertMcp", "removeMcp", "testMcp"]) {
    assert.match(main, new RegExp(`remoteManager\\.${method}\\(`));
  }
  assert.match(piHost, /new RemoteMcpRuntime/);
  assert.match(piHost, /this\.mcp\.toolsForProject\(projectPath\)/);
  assert.match(piHost, /this\.mcp\.callTool\(request\.toolName/);
  assert.match(piHost, /plugins\.resolveExecution/);
  assert.match(renderer, /capabilityRemote/);
});
