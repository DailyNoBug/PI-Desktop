# ADR 0232: Tree review and AI commit messages in Git

- Status: Accepted
- Date: 2026-09-11
- Deciders: PI-Desktop core
- Related: D405, D406, ADR 0231, `07-plugins/03-plugin-api.md`,
  `04-ux/08-component-spec.md`, E2E-255

## Context

The first Git work panel listed every changed file at one level and opened its
review overlay in unified mode. That is compact for one-file changes, but a
normal coding change spans several directories and the fastest way to inspect
it is the old/new split view. The commit field also required the user to write
the subject manually even though the panel already has bounded, scoped diffs.

Giving the plugin arbitrary file reads or shell access to gather prompt context
would weaken the boundary established by ADR 0231. Reusing the plugin-process
panel bridge for `agent.complete` would also impose the generic 30-second panel
timeout even though side completions have a 90-second budget.

## Decision

1. **Change lists are directory trees.** Each section groups descendants under
   collapsible folder rows. Folder rows aggregate descendant file and +/- counts;
   file rows retain status, rename, review, stage, unstage, and discard actions.
   A file click opens the Git-owned review modal over that tree; the Git tab
   remains the changed-file tree surface.
2. **Split diff is the default.** The review modal opens in left/right mode
   with red old-side and green new-side rows and aligned line-number columns.
   Unified mode remains an explicit toggle.
3. **AI commit messages use existing public boundaries.** `pi.git` additionally
   declares `models.list` and `agent.complete`. It selects the marked
   application default when that model is ready, otherwise the first ready
   model. The prompt is assembled only from current Git status and scoped
   diffs, is capped at 80,000 characters and 50 files, and never grants file,
   shell, network, or credential access.
4. **Panel completions are host-owned.** The fixed panel bridge exposes
   `agent.complete` directly to the permission gateway and completion service,
   preserving the 90-second side-completion budget without extending the
   generic plugin-process panel timeout.

The generated value is an editable commit message, not an automatic commit.
Model output is normalized and bounded, and the user still presses Commit.

## Consequences

- Large change sets remain navigable without hiding file-level Git actions.
- AI generation can fail or return unusable text; the panel keeps the existing
  message and shows a localized error.
- The plugin can request side completions when enabled, but the manifest and
   runtime permission gate remain visible and audited.

## Alternatives

- Keep a flat list: rejected because deep workspaces make related changes hard
  to scan and group.
- Add a private Git-to-model host API: rejected because `models.list` and
  `agent.complete` already define the needed public trust and audit boundary.
