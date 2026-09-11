# ADR 0219: Window-sized plugin view modals

- Status: Accepted
- Date: 2026-09-12
- Deciders: PI-Desktop core
- Related: D391, D392, D393, ADR 0104, ADR 0217, ADR 0218,
  `07-plugins/03-plugin-api.md`, `04-ux/08-component-spec.md`

## Context

A docked plugin view is a main-process `WebContentsView` whose bounds follow the
renderer-measured work-panel rectangle (ADR 0104). A dialog inside that page is
therefore clipped to the right panel even when its CSS uses the viewport. This
made the Git file-review dialog feel like a sidebar popover rather than an
application review modal.

Letting plugin CSS or a plugin-supplied rectangle resize the native view would
cross the placement boundary established by ADR 0104 and could let a view cover
arbitrary host surfaces.

## Decision

1. **Modal placement is a fixed, host-owned panel bridge.** A docked view with
   `ui.view` may call `view.prepareModal()` and then
   `view.setModal({ modal })`. Both calls are resolved from the calling
   `WebContents`; a cached or detached view, another plugin's view, and a plugin
   without `ui.view` are refused.
2. **The plugin never supplies geometry.** Preparation returns only the host's
   current dock rectangle and the host-computed modal rectangle. The page uses
   those values to keep its docked content visually anchored before the native
   bounds change, avoiding a layout flash.
3. **The host owns the lifecycle.** Entering modal mode expands only the active
   view to an inset application-window rectangle. The remembered dock rectangle
   remains authoritative for normal mode, window resize updates are pushed as
   `view:modal-geometry`, and hiding, switching, closing, reloading, disabling,
   or crashing the view restores the non-modal lifecycle.
4. **Git is the first consumer.** The Git tab remains a changed-file tree. A
   file click opens its review dialog across nearly the whole application
   window while the tree remains in the right-panel position behind the dialog.
   Message-owned Review snapshots and rollback stay unchanged.

## Consequences

- A plugin cannot request arbitrary window bounds, move the main window, or
  escape the existing plugin session and egress isolation.
- The modal surface deliberately keeps a host-visible outer margin so it does
  not cover the complete window edge. The dialog fills that host-owned surface.
- Third-party views can build window-scale dialogs, but every use inherits the
  same active-sender check, permission gate, and automatic reset.

## Alternatives considered

- **CSS-only fullscreen dialog**: rejected because the native view still clips
  it to the work panel.
- **A separate plugin window**: rejected because review context belongs to the
  docked Git surface and would duplicate window management.
- **A plugin-provided modal rectangle**: rejected because it would turn a
  placement state into an arbitrary host-surface override.
