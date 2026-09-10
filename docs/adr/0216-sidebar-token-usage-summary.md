# ADR 0216: Sidebar token usage summary

- Status: Accepted
- Date: 2026-09-11
- Deciders: PI-Desktop core
- Related: D103, D331, D335, ADR 0171, ADR 0173,
  `04-ux/06-settings-ia.md`, E2E-186

## Context

ADR 0173 removed the Settings Usage page because the marketplace plugin
`pi.token-insights` already provides the full cross-tool dashboard. That left
no always-present first-party way to check recent PI-Desktop token consumption;
users had to remember and open a separate plugin for a basic total.

The host already owns the authoritative completed-turn rollup through
`stats.getTokenUsageHistory`, including subagent usage that must not be merged
back into transcript assistant messages.

## Decision

1. **The expanded sidebar footer gains an Activity icon.** It sits at the left
   of Settings, uses the shared 32px footer target, and opens a non-modal
   summary popover above the footer.
2. **The renderer makes one read-only history request when the popover opens.**
   It asks for the last fourteen local-calendar day buckets and shows the range
   total, completed-turn count, daily distribution, and today's input, output,
   cache read, cache write, and reasoning totals. Opening again refreshes the
   summary; a failed request offers retry.
3. **Token Insights remains the dashboard.** The sidebar does not add filters,
   model/provider rankings, pricing, cross-agent imports, or JSONL backfill.
   Settings still has no Usage destination.
4. **No protocol, storage, or ownership change is made.** The popover reads the
   existing `stats.getTokenUsageHistory` IPC/RPC and never rewrites message
   usage.

## Consequences

- Recent PI-Desktop consumption is visible without installing a plugin.
- Users who need historical analysis continue to Token Insights.
- Historical turns recorded before Electron persisted usage may contribute zero
  even though Token Insights can backfill them from local transcripts.

## Alternatives

- Keep the data plugin-only: rejected for this product request; a basic recent
  total is shell status, not the full dashboard.
- Restore the Settings page: rejected because it would recreate the duplicate
  information architecture removed by ADR 0173.
