# 16. Trusted Extensions

> Status: Implemented v1 (D378, ADR 0207); implementation notes are marked "v1 note"
> Scope: v1. v2 and v3 items are listed in §12 and are not committed.

## 1. Purpose and terminology

PI-Desktop has two extension surfaces. Plugins
([01-plugin-system.md](01-plugin-system.md)) are sandboxed, manifest-driven,
and run outside the agent. Trusted extensions are the second surface: TypeScript
modules that run inside the Agent sidecar, receive an `ExtensionAPI` object, and
register tools, commands, and event handlers directly on the agent loop. The
`ExtensionAPI` contract is the one defined by `@earendil-works/pi-coding-agent`,
which PI-Desktop adopts as its in-sidecar extension contract alongside the
`pi-ai` and `pi-agent-core` kernel (ADR 0002). This document specifies that
surface.

| Term | Meaning |
|---|---|
| Trusted extension | A module written against `ExtensionAPI`, discovered from an extensions directory or a package with a `pi` manifest field, running with the trust level of the Agent sidecar |
| Plugin | A PI-Desktop plugin with a manifest, running in its own process under the permission gateway (ADR 0008) |
| Adapter | The layer in `packages/agent-runtime` that implements `ExtensionAPI` on top of the desktop runtime |
| Runner | One desktop-owned `TrustedExtensionRunner` instance bound to one desktop session (v1 note: the pi-coding-agent `ExtensionRunner` is not reused because it binds the terminal theme; its `ExtensionAPI` types are a types-only dependency) |

## 2. Positioning and trust model

1. Trusted extensions and plugins are distinct surfaces. Neither is
   converted into the other.
2. A trusted extension is trusted code. It executes inside the Agent sidecar,
   which already holds the bash, edit, and write tools, so enabling an
   extension grants exactly what running the agent already grants. The plugin
   security baseline in [04-plugin-security.md](04-plugin-security.md) does
   not apply and is not weakened.
3. Nothing is enabled by default. D007 stays in force: PI-Desktop never
   auto-imports `~/.pi`. Discovery lists candidates; the user enables each one.
4. Project-scoped extensions are gated per project. An extension found under
   a workspace's `.pi/extensions` loads only for that project and only after
   the user enabled it there. v1 note: PI-Desktop has no separate project
   trust state, so enablement is the trust decision and `project_trust` is
   not emitted.
5. On every surface the label is "Trusted extension" with the source path.
   Marketplace, signing, and update flows do not apply in v1.

## 3. Discovery and enablement

### 3.1 Sources

| Source | Path | Scope |
|---|---|---|
| User extensions | `~/.pi/agent/extensions/` | All projects |
| Project extensions | `<workspace>/.pi/extensions/` | That project, after project trust |
| Manual path | Any directory or file chosen in Settings | User chooses the scope |

Resolution inside a source follows the `pi-coding-agent` loader rules: a `package.json`
with a `pi.extensions` field declares its entry files; otherwise `index.ts`,
`index.js`, or a direct `*.ts` / `*.js` file one level deep. No deeper
recursion. The pi CLI's `settings.json` under `~/.pi/agent` is neither read nor
written in v1; enablement is PI-Desktop state.

### 3.2 Enablement state

- Stored in `~/.pi-desktop/trusted-extensions.json`, keyed by the realpath of
  the extension entry. No host-core schema change.
- Each entry records `enabled`, the scope (`user`, `project:<projectId>`, or
  `manual`), the source, and the last load diagnostic.
- A rescan is explicit (Settings button or app start). There is no file
  watcher in v1. A rescan never flips an enabled flag; a missing entry is
  shown as "missing" until the user removes it.
- Deleting a project does not delete its extension entries; they become
  orphaned and are removed on the next rescan.

## 4. Loading and runtime

### 4.1 Where extensions run

Extensions load inside the Agent sidecar process (`packages/agent-runtime`),
never in Electron main, the renderer, or a plugin host process.

### 4.2 Loader

- The sidecar pins `@earendil-works/pi-coding-agent` at exactly the version
  pinned for `pi-ai` and `pi-agent-core`, as a types-only dependency. The
  three versions must match; CI fails when they drift.
- The loader mirrors the `pi-coding-agent` discovery rules and uses
  `jiti/static` with `virtualModules`, so the babel transform is bundled
  and no path resolution happens at runtime. The bundling step is verified
  by a contract test that runs the bundle outside the repository (E2E-240).
- Import aliases: `pi-ai`, `pi-agent-core`, and `typebox` resolve to the
  sidecar's copies; `@earendil-works/pi-coding-agent` resolves to a runtime
  shim that exports `defineTool` and the tool-result type guards. `@earendil-works/pi-tui`
  resolves to a stub module that exports every symbol as an inert
  value so a top-level import never fails. Using a stubbed symbol raises a
  diagnostic at call time.

### 4.3 Runner per session

- Each desktop session gets its own Runner. The Runner is created with the
  session's runtime and disposed when the session's runtime is discarded.
- Module instances are shared across Runners because jiti caches modules.
  Module-level state is therefore shared between sessions, matching what an
  extension author sees when pi runs several sessions in one process. This
  is documented, not worked around, in v1.
- Enabling, disabling, or rescanning invalidates every Runner; affected
  sessions reload extensions at the next turn boundary. A running turn is
  never interrupted by a reload.

### 4.4 Load failures

A load error never fails the session. The extension is marked `error` with
the message and stack in diagnostics, the remaining extensions load, and the
turn proceeds. The composer shows a one-line notice when an enabled
extension failed to load for the active session.

## 5. API support matrix (v1)

Every `ExtensionAPI` member falls into exactly one class. Unsupported members
exist on the object, do nothing, return the documented neutral value, and
emit one diagnostic per extension per member. They never throw, so an
extension that only uses supported members works even if it also touches
unsupported ones.

| Class | Members |
|---|---|
| Supported | `registerTool`, `registerCommand`, `on(...)` for every event in §6, `exec`, `getActiveTools`, `getAllTools`, `setActiveTools`, `getCommands`, `setModel` (v1 note: returns `false`, the desktop owns the session's provider binding), `getThinkingLevel`, `setThinkingLevel`, `setSessionName`, `getSessionName`, `sendUserMessage` (Host-owned queue, D377), `getFlag` |
| Supported on context | `ui.notify`, `ui.confirm`, `ui.select`, `ui.input`, `ui.setStatus`, `ui.setWorkingMessage`, `cwd`, `modelRegistry`, `isIdle`, `abort`, `hasPendingMessages`, `getContextUsage`, `compact`, `getSystemPrompt`, `waitForIdle`, `newSession`, `fork` |
| Deferred to v2 | `sendMessage`, `appendEntry`, `setLabel`, `sessionManager` read API, `switchSession`, `registerShortcut`, `registerMarkdownTransformer`, `ui.setEditorText`, `ui.getEditorText`, `ui.addAutocompleteProvider`, `registerFlag` value editing |
| Unsupported | `ui.setWidget`, `ui.setFooter`, `ui.setHeader`, `ui.setTitle`, `ui.custom`, `ui.overlay`, `ui.onTerminalInput`, `ui.setWorkingVisible`, `ui.setWorkingIndicator`, `ui.setHiddenThinkingLabel`, `ui.pasteToEditor`, `ui.editor`, `registerMessageRenderer`, `registerEntryRenderer`, `navigateTree`, `shutdown` |

Neutral values: `getFlag` returns the declared default; `registerFlag` records
the declaration so `getFlag` works but exposes no CLI or UI in v1;
`sessionManager` accessors return empty results; UI setters return a no-op
`dispose`.

## 6. Event mapping

Events fire from the desktop runtime's existing hook points. Handler results
are honored where the event type defines a result.

| Event | Desktop hook point | Result honored |
|---|---|---|
| `session_start`, `session_shutdown` | Runner creation and disposal | No |
| `session_info_changed` | Session rename through `setSessionName` | No |
| `project_trust` | v1 note: not emitted; enablement per project is the trust decision | No |
| `resources_discover` | v1 note: not emitted; skills and prompt discovery stay in Electron main | n/a |
| `before_agent_start` | Before the first provider request of a turn | Yes, system prompt and message edits |
| `context` | `prepareNextTurn` | Yes, replacement message list |
| `before_provider_request`, `before_provider_headers`, `after_provider_response` | Provider call wrapper | Yes for request and headers |
| `agent_start`, `agent_end`, `agent_settled` | Agent loop boundaries | No |
| `turn_start`, `turn_end` | Turn boundaries | No |
| `message_start`, `message_update`, `message_end` | Agent message events | v1 note: no, pi-agent-core offers no post-hoc replacement |
| `tool_call` | `beforeToolCall` | Yes, block with reason |
| `tool_execution_start`, `tool_execution_update`, `tool_execution_end` | Tool execution stream | No |
| `tool_result` | `afterToolCall` | Yes, replacement result |
| `model_select`, `thinking_level_select` | v1 note: not emitted; a binding change retires the runtime | No |
| `session_before_compact`, `session_compact`, `session_compact_failed` | Compaction pipeline | Yes for `session_before_compact` |
| `session_before_fork` | v1 note: not emitted; fork runs in Electron main | n/a |
| `input` | v1 note: not emitted; Host queue admission is not wired yet | n/a |
| `user_bash`, `session_before_switch`, `session_before_tree`, `session_tree`, `ui_prompt_start`, `ui_prompt_end` | Not emitted in v1 | n/a |

A handler that throws is logged as a diagnostic and treated as returning
`undefined`. A handler that exceeds 30 s for a result-bearing event is
abandoned with a diagnostic and the turn proceeds with the unmodified value.

## 7. Tools

1. A registered tool joins the session's tool catalog under its declared
   name. A name that collides with a core tool, a plugin tool, or a user MCP
   tool is rejected with a diagnostic; the earlier registration wins.
2. Extension tools are non-core: they follow the same mode gating and
   ToolSearch deferral as plugin tools. They are available in Agent mode and
   follow the existing per-mode allowlist elsewhere.
3. Execution happens in the sidecar with the `ExtensionAPI` `execute` signature.
   No host permission prompt is raised; the trust decision was made at
   enablement. `onUpdate` streams map to tool execution update events.
4. Every execution writes an audit line with extension id, tool name, and
   duration. Parameters are not logged.
5. `exec` runs in the sidecar with the session's working directory and the
   session's proxy and environment settings.

## 8. Commands

1. `registerCommand` entries appear in the Commands section of global search
   (see [09-plugin-command-palette.md](09-plugin-command-palette.md)) as
   `/<name>` with the extension's label as the source, after built-in and
   plugin commands.
2. A command runs in the sidecar with the extension command context bound to
   the active session. It requires an active session whose runtime has
   loaded extensions in this app run; otherwise the composer reports that a
   chat must be started first.
3. Commands typed in the composer as `/<name>` resolve in this order:
   built-in, prompt template, plugin, extension. Collisions are diagnostics.
4. A running command blocks composer submission the same way a plugin command
   does and can be cancelled from the status line.

## 9. UI bridge

Interactive context calls travel sidecar → Electron main → renderer and back.

| Call | Renderer surface | Timeout | On abort |
|---|---|---|---|
| `ui.notify` | Toast | none | dropped |
| `ui.confirm` | Modal with two actions | 5 min | resolves `false` |
| `ui.select` | Modal list | 5 min | resolves `undefined` |
| `ui.input` | Modal text field | 5 min | resolves `undefined` |
| `ui.setStatus`, `ui.setWorkingMessage` | Floating status line for the active session (v1 note: not inside the composer) | none | cleared |

Rules:

- One pending interactive prompt per session. A second call queues behind
  the first.
- Aborting the turn cancels pending prompts with the abort values above.
- Under remote control (Post-MVP) the prompt fails immediately with
  `UNSUPPORTED` until the remote protocol routes it; that routing is v3.
- Prompts show the extension label and source path so the user knows who is
  asking.

## 10. Protocol and IPC additions

No host-core RPC method, protocol version, or SQLite schema changes in v1.

### 10.1 Sidecar → main (host.proxy allowlist)

| Method | Purpose |
|---|---|
| `extensions.commands.publish` | Replace the session's registered command list |
| `extensions.ui.request` | One interactive or status call from §9 |
| `extensions.diagnostics.publish` | Replace the session's diagnostics list |
| `session.rename`, `session.create`, `session.fork`, `session.queuePush`, `session.queuePrioritize` | Existing methods, now reachable from the adapter |

### 10.2 Main ↔ renderer (Electron IPC)

| Channel | Direction | Purpose |
|---|---|---|
| `extensions/list` | request | Candidates with scope, state, and diagnostics |
| `extensions/setEnabled` | request | Toggle one entry |
| `extensions/rescan` | request | Re-run discovery |
| `extensions/addPath` | request | Manual source via native picker token (D344 rules) |
| `extensions/commands/run` | request | Run a registered command in the active session |
| `extensions/ui/respond` | request | Answer a pending prompt |
| `extensions/changed` | event | List or diagnostics changed |
| `extensions/ui/prompt` | event | A prompt is pending |

All channels are sender-validated like other plugin channels and are absent
from the MCP control plane's `pi_desktop_invoke` allowlist.

## 11. Settings surface

Settings gains a "Trusted extensions" destination (tab id
`trustedExtensions`) in the Agent group beside Skills, MCP, and Subagents:

- A list grouped by source with the label, entry path, scope, enable toggle,
  and a state chip (`disabled`, `loaded`, `error`, `missing`).
- A diagnostics drawer per entry: load errors, unsupported API calls with
  counts, rejected registrations, handler timeouts.
- A "Rescan" action and an "Add path" action (main opens the native picker;
  the renderer never supplies a path).
- A short trust notice above the list stating what enabling grants.

## 12. Phasing

| Phase | Content | Commitment |
|---|---|---|
| v1 | §2 to §11: discovery, loader, Runner per session, support matrix, events, tools, commands, UI bridge, settings tab | Committed (D378) |
| v2 | Custom session entries (`sendMessage`, `appendEntry`) with a schema bump and a generic renderer, `sessionManager` read shim, `switchSession`, editor read and write, autocomplete providers, `registerShortcut`, markdown transformers | Planned, needs a decision on entry persistence and compaction |
| v3 | `pi` package manifests and installation, read-only hints from the pi CLI's `settings.json`, unified skill and prompt discovery, remote-control routing for prompts, marketplace listing | Not scheduled |

v1 delivery order: bundling spike (E2E-240), shared protocol types, then the
runtime, main, and renderer tracks in parallel.

## 13. Versioning policy

- Upgrading any pi package upgrades all three together.
- A fixture set of sample extensions covering each supported member runs as a
  contract test on every upgrade.
- New `ExtensionAPI` members land in the Unsupported class with a
  diagnostic until a later decision moves them.
- Public documentation promises only the Supported and Supported-on-context
  classes in §5.

## 14. Open decisions

| Question | Default until decided |
|---|---|
| Should v2 custom entries persist to host-core and take part in compaction? | Persist; excluded from compaction summaries |
| Should v3 read the pi CLI's `settings.json` enabled paths as discovery hints? | Read-only hints, never written |
| Should extension tools be selectable per project like plugin tools? | Scope from §3.2 is the only gate |
