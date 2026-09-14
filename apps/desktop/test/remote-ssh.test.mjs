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
    ["remoteDiscoverSshHosts", "discoverRemoteSshHosts"],
    ["remoteExportConnections", "exportRemoteConnections"],
    ["remoteImportConnections", "importRemoteConnections"],
    ["remoteTestConnection", "testRemoteConnection"],
    ["remoteAddConnection", "addRemoteConnection"],
    ["remoteUpdateConnection", "updateRemoteConnection"],
    ["remoteRemoveConnection", "removeRemoteConnection"],
    ["remoteConnect", "connectRemote"],
    ["remoteDisconnect", "disconnectRemote"],
    ["remoteUpgradeHost", "upgradeRemoteHost"],
    ["remoteRevokeDevice", "revokeRemoteDevice"],
    ["remoteDiagnostics", "remoteDiagnostics"],
    ["remoteImportProvider", "importRemoteProvider"],
    ["remoteDeleteProvider", "deleteRemoteProvider"],
    ["remoteListProjects", "listRemoteProjects"],
    ["remoteAddProject", "addRemoteProject"],
    ["remoteOpenProject", "openRemoteProject"],
    ["remoteRemoveProject", "removeRemoteProject"],
    ["remoteBrowseDirectory", "browseRemoteDirectory"],
    ["remoteSelectIdentityFile", "selectRemoteIdentityFile"],
    ["remoteRelayCatalog", "remoteRelayCatalog"],
    ["remoteRelaySet", "setRemoteRelayTools"],
    ["remoteTerminalOpen", "openRemoteTerminal"],
    ["remoteTerminalWrite", "writeRemoteTerminal"],
    ["remoteTerminalResize", "resizeRemoteTerminal"],
    ["remoteTerminalClose", "closeRemoteTerminal"],
  ]) {
    assert.match(protocol, new RegExp(`${channel}: "pi-desktop/remote/`));
    assert.match(api, new RegExp(`${fn}:`));
  }
  assert.match(protocol, /remoteChanged: "pi-desktop\/remote\/event\/changed"/);
  assert.match(protocol, /remoteTerminalEvent: "pi-desktop\/remote\/event\/terminal"/);
  assert.match(api, /onRemoteChanged/);
  assert.match(api, /onRemoteTerminalEvent/);
  assert.match(preload, /IPC_WHITELIST/);
});

test("managed SSH connections support one explicit password or identity credential", async () => {
  const [ui, dialog, api, main, manager, store, ssh] = await Promise.all([
    read("apps/desktop/src/components/settings/ConnectionsSection.tsx"),
    read("apps/desktop/src/components/settings/RemoteConnectionDialog.tsx"),
    read("apps/desktop/src/lib/api.ts"),
    read("apps/desktop/electron/main/index.ts"),
    read("apps/desktop/electron/main/remote-manager.ts"),
    read("apps/desktop/electron/main/remote-store.ts"),
    read("apps/desktop/electron/main/ssh.ts"),
  ]);
  assert.match(dialog, /useState<RemoteConnectionAuthMethod>\("agent"\)/);
  assert.match(dialog, /\["agent", "password", "identity"\]/);
  assert.match(dialog, /type="password"/);
  assert.match(dialog, /autoComplete="new-password"/);
  assert.match(dialog, /api\.selectRemoteIdentityFile\(\)/);
  assert.match(dialog, /api\.discoverRemoteSshHosts\(\)/);
  assert.match(dialog, /parseSshHostTarget\(target\)/);
  assert.match(api, /selectRemoteIdentityFile/);
  assert.match(main, /dialog\.showOpenDialog/);
  assert.match(main, /remoteSelectIdentityFile/);

  assert.match(store, /const \{ password: _password, \.\.\.durable \} = input/);
  assert.doesNotMatch(
    store.slice(store.indexOf("function durableConnectionInput"), store.indexOf("upsertDiscoveredConnection")),
    /["']password["']\s*:/,
  );
  assert.match(manager, /remote-connection:\$\{connectionId\}:password/);
  assert.match(manager, /secrets\.getForRuntime/);
  assert.match(manager, /secrets\.set/);
  assert.match(manager, /saved SSH password is missing/);
  const exportBlock = manager.slice(
    manager.indexOf("exportConnections(): string"),
    manager.indexOf("async importConnections("),
  );
  assert.doesNotMatch(exportBlock, /password/i);

  assert.match(ssh, /SSH_ASKPASS_REQUIRE: "force"/);
  assert.match(ssh, /BatchMode=no/);
  assert.match(ssh, /NumberOfPasswordPrompts=1/);
  assert.match(ssh, /askpass\.cjs/);
  assert.match(ssh, /const server = createServer\(\(socket\) => socket\.end\(password\)\)/);
  assert.match(ssh, /chmodSync\(socketPath, 0o600\)/);
  assert.match(ssh, /server\.listen\(socketPath/);
  assert.match(ssh, /named pipe|askpass\.sock/);
  assert.doesNotMatch(ssh.slice(ssh.indexOf("function askpassContext"), ssh.indexOf("function run(")), /SSH_PASSWORD_ENV/);
  assert.doesNotMatch(ssh.slice(ssh.indexOf("function askpassContext"), ssh.indexOf("function run(")), /\$\{password\}/);
});

test("reverse relay tools are explicit, permission-gated, and workspace-free", async () => {
  const [manager, store, shared, main, pluginRuntime, runtime, dialog] = await Promise.all([
    read("apps/desktop/electron/main/remote-manager.ts"),
    read("apps/desktop/electron/main/remote-store.ts"),
    read("packages/shared/src/remote.ts"),
    read("apps/desktop/electron/main/index.ts"),
    read("apps/desktop/electron/main/plugin-runtime.ts"),
    read("packages/agent-runtime/src/runtime.ts"),
    read("apps/desktop/src/components/settings/RemoteRelayToolsDialog.tsx"),
  ]);
  assert.match(shared, /relayTools\?: string\[\]/);
  assert.match(manager, /async relayCatalog\(/);
  assert.match(manager, /async setRelayTools\(/);
  assert.match(manager, /relay tools are unavailable:/);
  assert.match(manager, /private async advertiseRelayTools\(/);
  assert.match(manager, /client\.onRequest\(\(request\) => this\.handleRelayRequest\(runtime, request\)\)/);
  assert.match(manager, /relay tool is not selected:/);
  assert.match(manager, /requiresWorkspace: false/);
  assert.match(store, /setRelayTools\(id: string, toolNames: string\[\]\)/);
  assert.match(main, /pluginRequiresWorkspace\(tool\.pluginId\)/);
  assert.match(main, /userMcp\.toolsForProject\(null\)/);
  assert.match(main, /local relay tool requires workspace access:/);
  assert.doesNotMatch(main, /relay execute.*IPC\.invoke|IPC\.invoke.*relay execute/s);
  assert.match(pluginRuntime, /permission\.startsWith\("fs\."\)/);
  assert.match(runtime, /toolName\.startsWith\("plugin_"\) \|\| toolName\.startsWith\("mcp_"\)/);
  assert.match(runtime, /declaredRisk: def\?\.risk/);
  assert.match(dialog, /api\.remoteRelayCatalog\(connectionId\)/);
  assert.match(dialog, /api\.setRemoteRelayTools\(connectionId, selected\)/);
});

test("SSH lifecycle stays in Electron Main and never exposes keys to the renderer", async () => {
  const [manager, ssh, api, main, connections] = await Promise.all([
    read("apps/desktop/electron/main/remote-manager.ts"),
    read("apps/desktop/electron/main/ssh.ts"),
    read("apps/desktop/src/lib/api.ts"),
    read("apps/desktop/electron/main/index.ts"),
    read("apps/desktop/src/components/settings/ConnectionsSection.tsx"),
  ]);
  assert.match(manager, /class RemoteManager/);
  assert.match(manager, /secrets\.set/);
  assert.match(manager, /secrets\.getForRuntime/);
  assert.match(manager, /onAudit\("ssh\.host_key\.accepted"/);
  assert.match(manager, /onAudit\("remote\.pairing\.created"/);
  assert.match(manager, /onAudit\("remote\.pairing\.revoked"/);
  assert.match(manager, /onAudit\("remote\.permission\.decision"/);
  assert.match(manager, /async upgradeHost/);
  assert.match(manager, /PI_HOST_FORCE_RESTART: "1"/);
  assert.match(manager, /compareApplicationVersions\(remoteVersion, APP_VERSION\) > 0/);
  assert.match(manager, /remote Host is newer than Desktop/);
  assert.match(manager, /exportConnections\(\): string/);
  assert.match(manager, /async importConnections\(/);
  assert.match(manager, /slice\(0, 256\)/);
  const exportBlock = manager.slice(
    manager.indexOf("exportConnections(): string"),
    manager.indexOf("async importConnections("),
  );
  assert.doesNotMatch(exportBlock, /deviceToken|providerSecret|privateKey/i);
  assert.doesNotMatch(manager, /from "electron"/);
  assert.doesNotMatch(api, /child_process|node:child_process|ssh-spawn|privateKey/);
  assert.match(ssh, /resolveSshExecutable/);
  assert.match(ssh, /if \(connection\.sshConfigAlias\) \{/);
  assert.doesNotMatch(ssh, /connection\.source === "ssh-config" && connection\.sshConfigAlias/);
  assert.match(ssh, /proposeHostKeys/);
  assert.match(ssh, /confirmHostKeys/);
  assert.match(ssh, /if \(!error\) \{\s*resolve\(\{ code: 0, stdout: String\(stdout\), stderr: String\(stderr\) \}\);/);
  assert.match(ssh, /UserKnownHostsFile=\$\{knownHostsPath\}/);
  assert.match(ssh, /UserKnownHostsFile=\$\{proposed\.knownHostsPath\}/);
  assert.match(ssh, /StrictHostKeyChecking=yes/);
  assert.match(ssh, /StrictHostKeyChecking=accept-new/);
  assert.doesNotMatch(ssh, /ssh-keyscan/);
  assert.doesNotMatch(ssh, /StrictHostKeyChecking=no/);
  assert.match(ssh, /BatchMode=yes/);
  assert.match(ssh, /ExitOnForwardFailure=yes/);
  assert.match(ssh, /127\.0\.0\.1:\$\{localPort\}:127\.0\.0\.1:\$\{remotePort\}/);
  assert.match(main, /new RemoteManager|RemoteManager\.open/);
  assert.match(manager, /proposeHostKeys\(runtime\.connection, password\)/);
  assert.match(manager, /confirmHostKeys\(runtime\.connection, proposed, password\)/);
  assert.match(manager, /discardProposedHostKeys\(proposed\)/);
  assert.match(main, /remoteManager\.upgradeHost/);
  assert.match(main, /remoteManager\.revokeDevice/);
  const managerSource = manager.slice(
    manager.indexOf("async revokeDevice"),
    manager.indexOf("remoteProjectContext"),
  );
  assert.match(managerSource, /--stop/);
  assert.match(managerSource, /--revoke-device/);
  assert.match(managerSource, /secrets\.delete/);
  assert.match(connections, /api\.connectRemote/);
  assert.match(connections, /api\.disconnectRemote/);
  assert.doesNotMatch(connections, /TooltipButton|remote-connection-actions/);
  assert.match(main, /setAsDefaultProtocolClient\("pi-desktop"\)/);
  assert.match(main, /app\.on\("open-url"/);
  assert.match(main, /app\.on\("second-instance"/);
  assert.doesNotMatch(ssh, /StrictHostKeyChecking=no/);
});

test("SSH add uses a discovery modal and explicit target users override aliases", async () => {
  const [connections, dialog, ssh, shared] = await Promise.all([
    read("apps/desktop/src/components/settings/ConnectionsSection.tsx"),
    read("apps/desktop/src/components/settings/RemoteConnectionDialog.tsx"),
    read("apps/desktop/electron/main/ssh.ts"),
    read("packages/shared/src/remote.ts"),
  ]);
  assert.match(connections, /<RemoteConnectionDialog/);
  assert.match(connections, /remote-heading-row/);
  assert.match(connections, /remote\.connectRemoteDevice/);
  assert.doesNotMatch(connections, /settings-card-heading/);
  assert.match(connections, /remote-empty-card/);
  assert.doesNotMatch(connections, /api\.testRemoteConnection|api\.upgradeRemoteHost|api\.revokeRemoteDevice|api\.remoteDiagnostics/);
  assert.match(dialog, /mode === "discover"/);
  assert.match(dialog, /setMode\("manual"\)/);
  assert.match(dialog, /api\.discoverRemoteSshHosts\(\)/);
  assert.match(shared, /export function parseSshHostTarget/);
  assert.match(ssh, /if \(connection\.sshConfigAlias\) \{\s*const args: string\[\] = \[\];\s*if \(connection\.user\) args\.push\("-l", connection\.user\);/);
  assert.match(ssh, /connection\.user\?\.trim\(\) \? \{ user: connection\.user\.trim\(\) \}/);
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
  assert.match(main, /function remoteCapabilityContext/);
  for (const method of ["listMcp", "upsertMcp", "removeMcp", "testMcp"]) {
    assert.match(main, new RegExp(`remoteManager\\.${method}\\(`));
  }
  assert.match(piHost, /new RemoteMcpRuntime/);
  assert.match(piHost, /this\.mcp\.toolsForProject\(projectPath\)/);
  assert.match(piHost, /this\.mcp\.callTool\(request\.toolName/);
  assert.match(piHost, /plugins\.resolveExecution/);
  assert.match(renderer, /capabilityRemote/);
});

test("remote Skills manage the remote registry without local fallback", async () => {
  const [racp, manager, main, piHost, renderer] = await Promise.all([
    read("packages/shared/src/racp.ts"),
    read("apps/desktop/electron/main/remote-manager.ts"),
    read("apps/desktop/electron/main/index.ts"),
    read("packages/pi-host/src/pi-host.ts"),
    read("apps/desktop/src/components/settings/AgentSkillsPage.tsx"),
  ]);
  for (const operation of [
    "skills/list",
    "skills/create",
    "skills/update",
    "skills/read",
    "skills/remove",
    "skills/setEnabled",
    "skills/setScope",
  ]) {
    assert.match(racp, new RegExp(`"${operation}"`));
    assert.match(manager, new RegExp(`"${operation}"`));
  }
  for (const method of [
    "listSkills",
    "createSkill",
    "updateSkill",
    "readSkill",
    "removeSkill",
    "setSkillEnabled",
    "setSkillScope",
  ]) {
    assert.match(main, new RegExp(`remoteManager\\.${method}\\(`));
  }
  assert.match(piHost, /"skills\.create"/);
  assert.match(piHost, /"skills\.read"/);
  assert.match(renderer, /capabilityRemote/);
  assert.match(renderer, /remoteHost \? \[\] : \[\{/);
  assert.match(main, /revealing remote files locally is unsupported/);
});

test("local-only agent capabilities identify their remote availability", async () => {
  const [subagents, plugins, styles] = await Promise.all([
    read("apps/desktop/src/components/settings/AgentSubagentsPage.tsx"),
    read("apps/desktop/src/pages/PluginsPage.tsx"),
    read("apps/desktop/src/styles/plugins.css"),
  ]);
  assert.match(subagents, /capabilityLocal/);
  assert.match(subagents, /capabilityUnavailableRemote/);
  assert.match(subagents, /isRemoteProjectPath\(currentProjectPath\)/);
  assert.match(plugins, /AGENT_PLUGIN_CAPABILITIES/);
  assert.match(plugins, /locationUnavailableRemote/);
  assert.match(plugins, /isRemoteProjectPath\(currentProjectPath\)/);
  assert.match(styles, /\.plugins-tag\.is-warning/);
});

test("remote project picker offers recent paths from durable records", async () => {
  const renderer = await read("apps/desktop/src/components/settings/RemoteProjectDialog.tsx");
  assert.match(renderer, /api\.listRemoteProjects\(\)/);
  assert.match(renderer, /recentPaths/);
  assert.match(renderer, /normalizedRemotePath/);
  assert.match(renderer, /lastOpenedAt/);
  assert.match(renderer, /remote-recent-paths/);
});

test("remote regenerate branches stay on the remote Host", async () => {
  const [main, manager, piHost, racp] = await Promise.all([
    read("apps/desktop/electron/main/index.ts"),
    read("apps/desktop/electron/main/remote-manager.ts"),
    read("packages/pi-host/src/pi-host.ts"),
    read("packages/shared/src/racp.ts"),
  ]);
  assert.doesNotMatch(main, /Remote regenerate branches are not available yet/);
  assert.match(manager, /input: \{\s*text: content[\s\S]*?truncateFromMessageId: regenerate\.truncateFromMessageId/);
  for (const operation of [
    "session/revision/save",
    "session/revision/list",
    "session/revision/activate",
  ]) {
    assert.match(racp, new RegExp(`"${operation}"`));
    assert.match(manager, new RegExp(`"${operation}"`));
  }
  assert.match(piHost, /"session\.truncateFrom"/);
  assert.match(piHost, /"session\.saveActiveRevision"/);
  assert.match(piHost, /revisionRootId: revisionMeta\.rootUserId/);
});

test("remote terminal UI drives the remote PTY only", async () => {
  const [manager, main, panel, tabs, terminal] = await Promise.all([
    read("apps/desktop/electron/main/remote-manager.ts"),
    read("apps/desktop/electron/main/index.ts"),
    read("apps/desktop/src/components/workpanel/WorkPanel.tsx"),
    read("apps/desktop/src/lib/work-panel-tabs.ts"),
    read("apps/desktop/src/components/workpanel/TerminalTab.tsx"),
  ]);
  for (const operation of ["terminal/open", "terminal/input", "terminal/resize", "terminal/close"]) {
    assert.match(manager, new RegExp(`"${operation}"`));
  }
  for (const method of ["openTerminal", "writeTerminal", "resizeTerminal", "closeTerminal"]) {
    assert.match(main, new RegExp(`remoteManager\\.${method}\\(`));
  }
  assert.match(manager, /disconnectTerminals\(runtime\)/);
  assert.match(panel, /isRemoteProjectPath\(workspacePath\)/);
  assert.match(panel, /<TerminalTab sessionId=\{activeSessionId\} \/>/);
  assert.match(tabs, /\| "terminal"/);
  assert.match(terminal, /api\.openRemoteTerminal/);
  assert.match(terminal, /api\.writeRemoteTerminal/);
  assert.match(terminal, /api\.resizeRemoteTerminal/);
  assert.match(terminal, /api\.closeRemoteTerminal/);
});
