# 20. Remote SSH Desktop Client

- Status: Accepted for implementation
- Decision: D408 / ADR 0234
- Transport: `RACP-WS` over a system-OpenSSH local port forward
- Remote Host: Linux x64 or arm64 `pi-host`

## 1. Scope

This specification defines the Desktop-side Remote SSH product surface: SSH
discovery and management, bootstrap, pairing, port forwarding, reconnect,
remote projects, renderer routing, provider synchronization, and diagnostics.
The wire contract is owned by
[19-remote-agent-control-protocol.md](19-remote-agent-control-protocol.md);
remote execution is owned by `packages/pi-host`.

Remote SSH does not use SSHFS, SFTP mounts, repository synchronization, or a
per-command `ssh host "…"` wrapper. The remote Host is the authoritative
workspace, shell, session, queue, approval, and secret boundary.

## 2. Identities

```text
RemoteConnection
    └── RemoteHost
          ├── RemoteProject A
          │     ├── Session A1
          │     └── Session A2
          └── RemoteProject B
                └── Session B1
```

- `RemoteConnection` is durable, non-secret metadata in Electron Main.
- `RemoteHost` records the detected Linux architecture and negotiated versions.
- `RemoteProject` records the canonical remote absolute path and owning Host.
- A renderer-facing project path is `ssh://<connection-key><absolute-path>`,
  for example `ssh://gpu-a100/home/dev/project`.
- Every remote session carries `hostId`; absence means the local desktop Host.
- The same Remote Host may serve multiple projects concurrently. Switching the
  visible project never rewrites another session's project root.

Device tokens use the local host-core secret store with refs of the form
`remote-host:<hostId>:device-token`. Private-key bytes, provider API keys, and
device tokens never enter the renderer. A managed SSH password may be submitted
once as write-only input, but is never returned to the renderer and never enters
connection JSON, SQLite project metadata, SSH URLs, or logs.

## 3. SSH discovery and management

Settings owns a **Connections** destination.

1. On add-dialog discovery, Electron Main reads only concrete `Host` aliases and `Include`
   directives from the user's OpenSSH config. Pure patterns such as `Host *`
   are not entries.
2. Effective hostname, port, user, identity file, `ProxyJump`,
   `ProxyCommand`, `ControlMaster`, and all other connection semantics are
   resolved by system `ssh -G`.
3. A user may also create a manual connection with display name,
   `user@host` or `host`, port, and one explicit authentication choice:
   agent, password, or identity file. An explicit target user is authoritative
   even when an OpenSSH alias or configuration file supplies another user.
4. Authentication is delegated to system OpenSSH. Agent and identity modes use
   the user's agent and a durable path respectively. Password mode stores a
   write-only value in host-core's secret backend and supplies it through a
   secret-free launcher and temporary mode-0600 askpass socket; the durable
   connection and export documents contain only `authMethod`.
5. An unknown host key is proposed through the same system-OpenSSH connection
   options (including aliases, `ProxyJump`, and `ProxyCommand`) into a private
   temporary `known_hosts` file, displayed for explicit acceptance, confirmed
   with `StrictHostKeyChecking=accept-new`, fingerprint-checked against the
   proposal, and only then written to the user's real `known_hosts`.
   `StrictHostKeyChecking=no` is never injected.
6. Connections can be exported and imported as a versioned JSON document. The
   document contains only non-secret connection metadata; device tokens,
   provider credentials, private-key bytes, Host records, and projects are
   never included. Import validates every entry and updates an existing alias
   or managed endpoint instead of creating duplicates.

Each connection exposes state, source, last connected time, Host version,
connect/disconnect, test, explicit Host upgrade/restart to the current Desktop
version, device-token revocation, refresh, edit, remove, remote project
selection, and copyable diagnostics.

## 4. Bootstrap, pairing, and forwarding

Electron Main performs the ordered bootstrap:

1. resolve effective SSH configuration;
2. confirm the host key if needed;
3. probe Linux, architecture, home, and shell;
4. fetch the version-matched bundle checksum from the user's GitHub Release;
5. upload the bootstrap script over SSH;
6. SHA-256 verify, install or upgrade under `~/.pi-desktop/host`, and start the
   explicit `setsid` daemon without sudo;
7. exchange the one-time pairing token for a device token through RACP
   initialization;
8. store the device token locally and record the Host versions;
9. allocate an ephemeral local port and start
   `ssh -N -T -L 127.0.0.1:<local>:127.0.0.1:<remote>`;
10. initialize RACP and subscribe to Host and session events.

The Host must report the Desktop's RACP major version, Host protocol version,
and storage schema version. A mismatch is terminal for that attempt and offers
an upgrade rather than running Agent work against an incompatible Host.
Only an older Host is automatically or explicitly upgraded to the Desktop's
version. A newer Host enters `incompatible` and requires a Desktop upgrade;
PI-Desktop never downgrades it.
The explicit upgrade action closes the local transport, reruns the checksummed
bootstrap with forced restart, and reconnects through the same pairing path; it
never installs an unverified bundle or bypasses version negotiation.
Device-token revocation disconnects the local RACP client, stops the remote
Host, clears the owner-only token file, deletes the local secret, and requires
a new pairing exchange before the next connection.

## 5. Reconnect

The default retry schedule is `0s, 1s, 2s, 4s, 8s, 15s, 30s, 30s…`. Explicit
disconnect cancels it. Authentication failure, rejected host key, revoked
token, checksum mismatch, and protocol incompatibility do not retry blindly.

Each RACP subscription keeps the last durable `{ epoch, sequence }` cursor.
Reconnect resubscribes from that cursor; a new epoch or evicted cursor requests
a snapshot. Remote turns continue while the Desktop is disconnected, and
completed tool calls or admitted prompts are not resubmitted.

## 6. Renderer routing

The renderer keeps using `lib/api.ts`; it has no SSH, child-process, key, or
token API. Electron Main routes by session `hostId` or canonical `ssh://`
project path:

| Existing API | Remote route |
|---|---|
| session list/create/get/fork/configure/rename/delete/compact | corresponding RACP remote-host operation |
| prompt, regenerate, stop, abort, status, queue | `turn/start` (including host-owned truncation), `turn/stop`, `turn/interrupt`, revision operations, snapshot, queue operations |
| tool permission and AskTool resolution | `approval/respond`, `input/respond` |
| Plan/Goal pending and resolve | remote approval request and response |
| Files list/read/index and Review diff | `workspace/list`, `workspace/read`, `workspace/diff` |
| project get/list/set/clear | local remote-project records and the active Host |

The work panel offers a Terminal tool only while a remote project is active.
It opens a remote pty, streams base64 PTY output through RACP, propagates
measured size changes, and marks the UI disconnected when the advertising
connection closes. Closing the tab closes the remote terminal; reconnect does
not attempt to reattach the dead pty.

Remote agent events are converted back to the shared normalized
`AgentEventEnvelope` before reaching the existing transcript reducer. Local
file pickers, local reveal/open actions, local scratch attachment import, and
local-only review rollback are hidden or return `UNSUPPORTED` for a remote
project instead of silently touching local disk.

Remote project prompts resolve the Host's active global and project Skills from
its own `~/.agents` and `<workspace>/.agents` registries. The model-facing
catalog contains ids, names, and descriptions only; a `Skill` call is answered
by the remote Host with `skills.read`, so skill bodies and execution remain on
that Host. Plan mode rejects the Skill tool exactly as the local runtime does.
The remote project picker browses through `workspace/browse`, accepts absolute
remote paths, offers the Host home directory, and lists recent normalized paths
from that connection's durable `RemoteProject` records.
Settings routes Skill list, create/edit, delete, enable/scope, read, and local
Markdown import to those remote registries. Import reads the selected local
document once in Electron Main and writes its body through RACP; it never
mounts the remote filesystem. Local reveal is hidden because the path belongs
to the remote Host.

The same rule applies to user-owned MCP servers. Settings routes MCP list,
create/edit, delete, enable/scope, import, and test calls to the selected
remote project through owner-only RACP operations. `pi-host` starts stdio
processes on that Host (or opens its HTTP endpoints), discovers their tools,
and resolves model calls locally to the remote process; a Desktop MCP process
is never a silent substitute. Capability rows label their execution location as
`Remote: <connection-key>`.

Connections also own reverse relay selection. Electron Main catalogs only
active local plugin tools that request no filesystem permission and tools from
the user's local MCP configuration. The selected names persist per
`RemoteConnection`, are revalidated against the current catalog, and are
advertised with their schema, source, and declared risk after RACP
initialization. The remote Host runs its normal permission flow before
requesting desktop execution; Electron Main executes only a currently selected,
workspace-free tool and rejects stale, unselected, filesystem-requiring, or
arbitrary IPC requests. Relayed descriptors and requests never carry private
keys, device tokens, provider credentials, or Host secrets.

Local-only registries are labeled instead of being misrepresented as remote.
The Subagents settings page marks its Desktop-local global registry `Local` and
`Unavailable remotely` while a remote project is active. The Plugins page marks
every Desktop plugin `Local`; agent tools, plugin Skills, plugin MCP, and
trusted extensions that have not been explicitly relayed are additionally
marked `Unavailable remotely`. Panel, view, command, theme, service, and other
Desktop-shell capabilities remain local without claiming remote availability.

## 7. Remote providers

Settings shows which selected provider credential will be written to which
remote machine. Sync sends an already validated provider record plus its secret
over the SSH channel to `pi-host --provider-import`; the remote Host stores it
in its own secret backend. Deletion invokes `pi-host --provider-delete`.
Provider secrets never cross RACP.

## 8. Diagnostics

Copy diagnostics contains Desktop version, RACP version, local platform and
architecture, SSH availability, connection stage, remote platform and
architecture, Host version, last error and exit code, forward state, handshake
state, and whether a project path is configured. User names, IPs, home paths,
identity paths, tokens, credentials, and environment values are redacted.

## 9. Deep links

The packaged app registers the `pi-desktop` scheme. Two routes are stable:

```text
pi-desktop://connections/ssh/add?name=GPU&alias=gpu-server
pi-desktop://projects/remote/open?connection=gpu-server&path=/home/dev/project
```

Deep links are queued until local host-core and the Remote manager are ready.
Both routes require native confirmation; an inbound URL can never silently
trust a host key, add a connection, or open a remote path. The parser rejects
unknown hosts, wildcard connections, relative paths, dot-segment escapes,
invalid ports, and whitespace in connection aliases. Project links address a
connection by its stable UI key, resolve through the same durable project
registration path, and emit the existing renderer project-change event.

## 10. Acceptance

1. SSH-001 through SSH-012 in the product requirement are represented by
   E2E-231 and the Remote SSH source-contract tests.
2. A remote Read, Write/Edit, Bash, Git-via-Bash, stream, Stop, approval, diff,
   and session reload executes only on the remote Host.
3. Dropping SSH during a turn leaves the Host authoritative and reconnect resumes
   by cursor without duplicate prompts or completed tool calls.
4. Multiple projects on one Host and multiple Hosts can be registered; sessions
   remain bound to their originating roots.
5. No renderer channel can spawn SSH, read a key, obtain a device token, or
   invoke arbitrary local filesystem operations for a remote project.
