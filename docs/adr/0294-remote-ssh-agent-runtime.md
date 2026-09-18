# ADR 0294: Remote SSH Agent Runtime

- Status: Accepted for implementation
- Date: 2026-09-12
- Decision: D434
- Related: ADR 0205 (D373 / D374 / D375 / D385), ADR 0213, ADR 0108,
  `02-architecture/05-remote-agent-control.md`,
  `03-runtime/19-remote-agent-control-protocol.md`,
  `05-security/02-remote-control-security.md`

## Context

Remote SSH must provide the same workspace, tool, session, approval, and
recovery semantics as the local desktop. A per-command SSH wrapper, SSHFS, or a
synchronized local copy would split filesystem and process authority, leak
local paths into remote sessions, and make disconnect recovery unsafe.

## Decision

1. The desktop remains the UI and controller. A remote Linux machine runs a
   `pi-host` bundle containing the headless `AgentHost`, Rust host-core, and
   Node agent runtime. Remote filesystem tools, Bash, Git, Skills, MCP, and
   subagents execute on that machine.
2. `RACP-WS` is the only client transport. `pi-host` binds remote loopback,
   requires the `pi-racp.v1.jsonrpc` subprotocol and a device token, and is
   reached only through a system-OpenSSH local port forward. The first
   initialization may exchange a single-use SSH pairing token for a device
   token in the initialization result.
3. Electron Main owns SSH discovery, pairing, bootstrap, forwarding,
   reconnect, diagnostics, and routing. The renderer keeps calling the existing
   typed API surface and never receives SSH credentials or private-key bytes.
4. SSH aliases and effective configuration are resolved by the user's system
   OpenSSH. PI-Desktop stores only managed connection metadata and identity
   file paths; authentication remains with OpenSSH and the user's agent.
5. A remote project is identified by a stable URI such as
   `ssh://gpu-a100/home/dev/project`, not by a local absolute path. Multiple
   projects and sessions can share one remote Host while remaining bound to
   their originating project roots.
6. Remote sessions, turns, queues, approvals, events, and transcripts are
   authoritative on `pi-host`. The desktop caches display state and resumes
   with `{ epoch, sequence }` cursors or a snapshot.
7. Remote provider credentials are written as Host-local configuration over
   the SSH bootstrap channel and stored only in the remote Host's secret
   backend. Provider secrets never cross RACP.
8. The bootstrap downloads a versioned, platform-specific `pi-host` bundle from
   the user's GitHub release, verifies SHA-256 before extraction or execution,
   installs under the remote user's home, and records an explicit daemon
   lifecycle and PID. Silent sudo and host-key bypasses are forbidden.

## Consequences

The local desktop gains a true remote runtime without duplicating renderer
tools, but the release pipeline must publish Linux x64 and arm64 `pi-host`
bundles and the desktop must supervise pairing, port forwarding, version
negotiation, and recovery. Local sessions continue through the same headless
Host module and existing host-core boundary.
