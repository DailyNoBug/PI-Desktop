# ADR 0231: Bundled Git work panel

- Status: Accepted (amended by ADR 0232 / D406)
- Date: 2026-09-11
- Deciders: PI-Desktop core
- Related: D246, D247, D248, D405, ADR 0104, ADR 0105, ADR 0170,
  `07-plugins/03-plugin-api.md`, `04-ux/08-component-spec.md`, E2E-254

## Context

The work panel can inspect files and browser pages, but a coding workspace
still lacks the common source-control loop: see what changed, review a file,
stage or unstage it, commit, synchronize with the upstream, and move between
branches. The existing Review tab is message-owned and intentionally preserves
the snapshot produced by a tool call; it must not become a mutable Git client.

Exposing a shell to a plugin would be the easiest implementation, but it would
also expose credentials, arbitrary remotes, merge behavior, and unbounded
output to plugin code.

## Decision

1. **Git is a default bundled plugin.** `pi.git` contributes the `changes`
   work-panel view with the host `branch` icon. It is disableable and uses an
   ordinary manifest; it has `ui.view`, `git.read`, and `git.write` and no
   private host capability.
   *Amended by ADR 0232:* the plugin also declares `models.list` and
   `agent.complete` for AI-generated commit messages.
2. **Electron Main owns a structured Git service.** Public plugin calls map to
   fixed Git argv in the active workspace. Inputs use safe relative paths;
   output and file counts are bounded; operations use timeouts; and mutations
   for one workspace are serialized. Untracked directories aggregate at the
   highest path Git reports so internal backup or metadata trees cannot exhaust
   the file limit and hide unrelated changes. The legacy `workspaceDiff` IPC
   remains unchanged.
3. **The public API is fixed and permission-gated.** `git.read` unlocks
   `status`, `branches`, and `diff`; `git.write` unlocks stage, unstage,
   discard, branch create/switch, commit, push, and pull. There is no arbitrary
   command, remote, force operation, stash, tag, or merge-resolution API.
4. **Dangerous choices require native consent.** Discard, branch switch, and
   create-and-switch show a host-owned dialog. Discarding tracked changes
   restores from `HEAD`; untracked files go to the OS trash. Other write
   actions run directly after their explicit button action.
5. **Push and pull stay branch-local.** Push uses the configured upstream;
   publishing explicitly sets `origin/<current-branch>`. Pull is always
   fast-forward only. Credentials remain with the user's Git credential
   helper, terminal prompts are disabled, and PI-Desktop stores no Git
   credential.
6. **Audits contain metadata only.** A Git audit records plugin id, operation,
   result/error code, path count, and branch. It never records paths, diff
   content, commit messages, credentials, or raw remote output.

The bundled review overlay reads current Git state and is independent from the
message-owned Review tab. It offers no rollback because rollback belongs to the
recorded post-tool snapshot in Review.

## Consequences

- The core VS Code-style source-control workflow is available without a
  third-party plugin.
- Plugin authors receive a reusable but deliberately narrow Git API.
- Diverged or conflicted repositories require the user to resolve them outside
  this v1 surface; the panel reports the bounded Git error rather than creating
  a merge commit.

## Alternatives

- Implement Git as a host work-panel tab: rejected because plugin views are
  now the established extension point and a public API is needed either way.
- Expose shell execution with a command allowlist parser: rejected because
  parsing reconstructed command strings is weaker than fixing argv at the
  service boundary.
- Put Git in Rust host-core: deferred; the existing bounded workspace diff
  already lives in Electron Main and this feature does not change durable
  session or tool ownership.
