# ADR 0278: Managed SSH Password Authentication

- Status: Accepted for implementation
- Date: 2026-09-14
- Decision: D435
- Related: ADR 0277, `03-runtime/20-remote-ssh-desktop.md`,
  `04-ux/06-settings-ia.md`, `05-security/02-remote-control-security.md`

## Context

ADR 0277 delegated manual SSH authentication to the user's OpenSSH agent or an
identity-file path. That avoids storing a password, but it blocks users whose
remote provider only issues a password and does not make the manual-connection
form's credential choice explicit.

## Decision

1. A managed SSH connection selects exactly one authentication mode: SSH agent,
   password, or identity file. Agent remains the default. Identity mode requires
   an absolute or user-typed identity path selected through a Main-owned native
   file dialog; PI-Desktop never reads private-key bytes.
2. The password field is write-only. The renderer may submit a new value, but a
   connection view never returns it. Electron Main stores it only in host-core's
   secret backend under `remote-connection:<id>:password`; durable connection
   JSON, import/export documents, diagnostics, and logs contain only
   `authMethod`.
3. System OpenSSH remains the authentication engine. Password mode uses a
   temporary launcher with no embedded secret and OpenSSH's forced askpass
   protocol. The value stays in Electron Main memory and is retrieved by the
   helper over a mode-0600 Unix socket (or local named pipe); it never enters
   command-line arguments, persistent files, the SSH child environment, or the
   remote command environment. The launcher and socket are deleted when the SSH
   process exits.
4. Agent and identity modes retain `BatchMode=yes`. Password mode uses exactly
   one password prompt so reconnect and bootstrap do not hang indefinitely.

## Consequences

Users can choose a password or identity without supplying both, and existing
agent-based configurations remain unchanged. The Desktop keeps the password in
Main memory and a short-lived local askpass socket; it does not persist that
value or expose a renderer read API.
Exported password-mode connections still require the user to re-enter the
password on the importing desktop.
