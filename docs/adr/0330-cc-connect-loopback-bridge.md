# ADR 0330: CC Connect external session control behind a loopback RACP bridge

- Status: Accepted for implementation
- Date: 2026-09-19
- Decision: D658
- Related: ADR 0205 (RACP boundary), ADR 0285 (RACP-WS transport), ADR 0286
  (remote host desktop kernel), ADR 0080 (plugin isolation), D375, spec
  `03-runtime/19-remote-agent-control-protocol.md`,
  `03-runtime/21-cc-connect-bridge.md`

## Context

CC-Connect drives coding agents from messaging platforms (WeChat Work,
Feishu, Telegram, Discord, Slack, …) through pluggable agent backends. Its
existing `pi` backend shells out to the `pi` CLI as a separate process with
its own state, so messages from a chat app never reach the sessions the
PI-Desktop UI shows. Users want the opposite: chat-controlled turns that run
in real desktop sessions, sharing their queue, transcript, and approvals.

The desktop already has everything needed to serve such control: an
in-process Agent Host whose turns flow through the same registered IPC
handlers the renderer uses, and the RACP server stack (auth, pairing,
roles, event replay, approvals) that the headless host serves. What is
missing is a desktop-hosted endpoint and a management surface for the
daemon.

## Decision

1. **Electron main hosts a loopback RACP-WS bridge.** A new
   `bootstrap/racp-bridge.ts` composes `RacpServer` +
   `bindRacpWebSocket` over the desktop's in-process Agent Host and a
   desktop `RacpHostOperations` profile built from the shared
   `createHostOperations` (moved to `@pi-desktop/host-runtime`), with
   catalog mutations routed through the existing session IPC handlers so
   the UI, sidecar bookkeeping, and host-core stay on the desktop path.
   The bridge binds `127.0.0.1:0` (ephemeral, loopback-only by
   construction) and writes a 0600 discovery file
   (`racp-bridge.json`: url/host/port/version/pid/startedAt — no token)
   plus a separate 0600 token file (`racp-bridge.token`).

2. **External control is a scoped device, never a second runtime.** The
   bridge mints one dedicated device with roles
   `viewer/controller/approver` — never `owner` — so session deletion,
   device revocation, and project registration stay desktop-side. Turns
   admitted over the bridge flow through the same Agent Host the renderer
   uses (`agentPrompt`/`agentStop`/approvals), which keeps the desktop
   queue, events, and transcript authoritative. No agent execution moves
   into new places.

3. **cc-connect is managed, not bundled.** A `cc-connect-controller.ts`
   service detects an existing `cc-connect` executable (PATH plus known
   install locations, or a user-configured path), starts it with
   user-visible arguments (typically `--config <plugin-data>/config.toml`
   pointing at PI-managed configuration), and owns stop/restart plus a
   bounded, token-redacted log tail. Nothing is downloaded;
   `~/.cc-connect` is never read or written — PI-managed configuration
   lives under the plugin data directory.

4. **The plugin gates the surface.** The bundled `pi.cc-connect` plugin
   exposes the panel (status, daemon lifecycle, binding CRUD, logs,
   setup) through a new `pi.ccConnect.*` host API behind a new
   `ccconnect.control` permission (deny-by-default). Bindings persist in
   plugin settings and materialize as a `bindings.json` the cc-connect
   `pidesktop` backend resolves per conversation (`CC_SESSION_KEY`):
   `fixed`, `latest` (newest session of a project), or `new`.

5. **Attachments ride the reserved RACP attachment operations.**
   `attachment/create|put|complete` stage uploads into the desktop's
   content-addressed attachments blob store with per-file size caps,
   sequential chunks, canonical base64, name sanitation, and an
   executable-extension blocklist; `turn/start` resolves attachment ids
   to staged paths scoped to the owning session. Clients never pass
   readable paths.

## Consequences

- Chat turns are first-class desktop turns: identical queue, approvals,
  transcript, and UI visibility; approvals may be answered from either
  side of the bridge (`approval/respond` and the desktop card settle the
  same pending request).
- The external principal is intentionally less than `owner`; remote
  project registration and device management require the desktop.
- The bridge is off until the user enables it, and the enabled state
  restores across restarts; shutdown disposes the bridge and the daemon
  (shutdown contract updated).
- `packages/host-runtime` gains a dependency on `@pi-desktop/racp` for
  the shared host-operations implementation and credential store.
- E2E-270 exercises the vertical slice against a real `pi-host` with a
  stub model; real messaging platforms remain user-assisted validation.

## Alternatives considered

- Spawn the standalone `pi-host` app against the desktop dataDir —
  rejected: a second host-core/sidecar pair on one dataDir splits brain
  with the desktop's own services, and external turns would not flow
  through the desktop's event fan-out.
- Let the plugin spawn the daemon with raw `node:child_process` —
  rejected: outside the permission system; the sanctioned shape is a
  host-owned controller behind an audited permission.

## Limitations

- `input.requested` (structured AskUserQuestion) has no messaging
  counterpart yet; requests expire host-side.
- Attachment uploads are one-way (chat → agent); agents deliver files by
  path references in the transcript, as on the desktop.
- The bridge serves one local daemon; a multi-daemon or remote Gateway
  deployment remains future work.
