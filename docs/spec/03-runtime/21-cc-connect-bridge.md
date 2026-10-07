# 21. CC Connect Bridge

- Status: Current
- Decision: D658 / ADR 0330
- Depends on: `19-remote-agent-control-protocol.md` (RACP 1.0, RACP-WS),
  `07-process-model.md`, `03-tools-and-permissions.md`

This document specifies the CC Connect integration: a locally-managed
cc-connect daemon controlling real PI-Desktop projects and sessions from
messaging platforms, over an authenticated loopback RACP bridge hosted by
the desktop.

## 1. Architecture

```
Messaging platform (WeChat Work / Feishu / Telegram / Discord / Slack / …)
   ↓  (platform connectivity; cc-connect's own transports)
cc-connect daemon  — started by the desktop from a local executable,
   ↓                 configured with PI-managed config.toml + bindings.json
agent backend `pidesktop` (Go, in cc-connect)
   ↓  RACP-WS over 127.0.0.1:<ephemeral>, Bearer device token
Desktop RACP bridge (Electron main, `bootstrap/racp-bridge.ts`)
   ↓  in-process Agent Host + RacpHostOperations profile
Existing PI project/session/Agent runtime (sidecar execution, host-core
   persistence, desktop queue, approvals, transcript)
   ↔  PI-Desktop desktop UI (same sessions, live)
```

The daemon and the bridge are separate processes with separate lifecycles;
the bridge serves the desktop's own Agent Host, so external turns are
desktop turns — they enter through `agentPrompt`/`agentStop` IPC handlers,
share the persisted queue, stream through the same event fan-out, and
resolve approvals through the desktop permission handler.

## 2. Security and threat model

- **Authentication**: every WS upgrade requires a Bearer device token
  (SHA-256-hashed at rest, constant-time compare). The bridge device is
  minted once with roles `viewer/controller/approver`; `owner` operations
  (session delete, device revoke, project register/browse, skills, MCP)
  are refused by role. The desktop principal is unaffected.
- **Exposure**: the listener binds `127.0.0.1` with an ephemeral port;
  non-loopback binds are refused by the WS binding, non-loopback peers
  get 403. Discovery lives in `<dataDir>/racp-bridge.json` (0600, no
  token); the token is a separate 0600 file on the same machine.
- **Enablement**: the bridge is disabled until the user enables it in the
  CC Connect panel; the choice persists and restores on boot. Disable
  stops the listener and removes the discovery file.
- **Daemon**: started only from a locally-detected executable (never
  downloaded); PI-managed configuration lives under the plugin data
  directory — `~/.cc-connect` is never read or written. The log tail is
  bounded and redacts token-shaped strings (`pdt1.`/`ppt1.`).
- **AI boundary**: external chat text is untrusted user input to the
  session, exactly like desktop input; tool approvals still gate every
  high-risk action. The bridge never widens a permission ceiling and
  never enables bypass/yolo; `allow-session` from the bridge device is
  refused host-side (non-paired remote principal).
- **Attachments**: uploads stage into the content-addressed attachments
  blob store (size-capped, chunked, canonical base64, sanitized names,
  executable extensions refused); `turn/start` accepts only staged
  attachment ids bound to the same session. Remote users cannot name
  readable paths.

## 3. Protocol mapping

The wire surface is RACP 1.0 / RACP-WS (`19-remote-agent-control-protocol.md`)
with these capabilities exercised:

| cc-connect need | RACP operations |
| --- | --- |
| discovery/auth | `connection/initialize` (+ `notifications/initialized`), Bearer device token |
| list projects / sessions | `project/list`, `session/list`, `session/get` |
| create / select session | `session/create` (title, project, ask mode), binding resolution client-side |
| send user message | `turn/start` (admission `queue`, idempotent request ids, staged attachment refs) |
| stream response | `events/subscribe` (`session` scope); `item.delta` text, `item.started|completed` tools |
| abort | `turn/interrupt` (active) / `turn/cancel` (queued) |
| approvals | `approval.requested` event → `approval/respond` (`allow-once`/`deny` only) |
| attachments | `attachment/create` → `attachment/put` (≤512 KiB chunks) → `attachment/complete` |
| resume | cursor persistence + `session/attach` (`after`), snapshot on `resync` |

Desktop-side catalog mutations (create/configure/fork/rename/delete) are
routed through the registered session IPC handlers so renderer state and
host-core stay on the desktop path; `session.changed`-style notifications
refresh open panels.

## 4. Setup

1. Install cc-connect locally (any supported channel credentials already
   configured there stay in cc-connect's own files).
2. In PI-Desktop, open the **CC Connect** work panel, flip **Enable
   bridge**, then **Start daemon**. The plugin generates
   `<plugin-data>/config/config.toml` (agent `pidesktop`,
   `token_file` → the desktop token file, `bindings_file` → the panel's
   bindings file, `permission_mode = "ask"`) and starts
   `cc-connect --config <file>`.
3. Add conversation bindings in the panel; they persist in plugin
   settings and are materialized to `bindings.json` atomically.
4. Message the bot from a bound conversation.

Diagnostics: the panel shows executable detection (with an install hint —
nothing is downloaded), bridge URL and running state, daemon pid/logs,
and auth failures surface as errors with the controller's message.

## 5. Binding semantics

A binding is `(platform, account, conversation)` → `(project, session,
mode)`. The `pidesktop` backend resolves the PI session at
`StartSession(sessionID)`:

| mode | resolution |
| --- | --- |
| `fixed` | the binding's `sessionId`; verified with `session/get` (falls through to re-resolution when missing) |
| `latest` | newest `session/list` entry of the binding's `project` by `updatedAt` |
| `new` | `session/create` with the configured title; the engine persists the resolved id per chat and resumes it on later messages |

Bindings are stored in plugin settings (host-persisted, survives
restarts of both processes) and materialized to `bindings.json`
(atomically, 0600). The cc-connect engine additionally persists the
agent-side session id per chat, so an unbound conversation keeps its
session; `session/get` + persisted cursors make resume idempotent — a
reconnect never duplicates a PI session.

## 6. Recovery and reconnect

- The Go client keeps a per-session durable cursor (`epoch`, `sequence`).
  On transport loss it reconnects with bounded backoff, re-initializes,
  re-attaches with the stored cursor, and processes replayed durable
  events exactly once; a `replayComplete: false` resync re-reads the
  snapshot and continues live.
- A pi-host/desktop restart changes the ephemeral port; the daemon re-reads
  the discovery file (or is handed the new URL) and resumes by cursor.
  Binding and session continuity are covered by E2E-270 phase 2.
- Desktop restart restores the bridge when previously enabled; the device
  token file lets the daemon reconnect without re-pairing.

## 7. Limitations

- `input.requested` (structured AskUserQuestion) is not surfaced to chat;
  requests expire host-side (documented timeout).
- Attachments are one-way (chat → agent); agent-produced files are
  referenced by path in the transcript, as on the desktop.
- One local daemon per desktop; Gateway/multi-host topologies remain
  RACP Gateway future work.
- Real messaging platforms and real model providers are user-assisted
  validation (E2E-270 uses a stub model and the Go backend as the
  platform edge).
