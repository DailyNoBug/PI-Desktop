# ADR turn-process-and-thinking-display: Turn process and thinking presentation

- Status: Accepted
- Date: 2026-09-17
- Issues: #510, #461
- Amends: D071, [ADR 0242](0242-delta-only-streaming-updates.md)

## Context

A model can alternate reasoning, tool calls and progress text many times before
answering one user request. Separate activity groups leave those progress
messages at the same visual level as the answer. Some readers also need a
thinking indicator without rapidly changing reasoning text.

## Decision

The renderer projects each existing assistant-turn entry into one process
area and its trailing answer. Thinking, tools and intermediate assistant text
keep their original order inside the process. A trailing assistant text stays
visible while streaming; if a later tool or thinking block follows, that text
belongs to the process. There is no semantic final-answer marker in UiMessage,
so the renderer does not guess intent from the wording. User/system messages
and compaction dividers retain their existing turn boundaries.

Completed process areas start collapsed. Detailed mode opens the active
process automatically and retains the existing thinking-row disclosures.
Manual disclosure choices survive streaming and completion. Search navigation
opens the containing process. Tool failures open an unclaimed active process so the
invocation error stays visible; that does not mark the whole turn as failed.
Assistant errors and stopped trailing partial answers stay outside the process.
Tool/delegation detail controls, permission cards, and transcript actions retain
their existing behavior.

Settings → AI → Defaults includes `thinkingDisplayMode`, an optional
`detailed | compact` AppSettings field. Absent or unrecognized values display
as detailed. Compact mode renders no reasoning text or excerpt: while a
thinking-only message streams it shows a status indicator, and when reasoning
ends the thinking row disappears. Answer text ends that indicator even while
the assistant message is still streaming. A completed thinking-only process
leaves no empty header. Tool rows and progress text remain expandable.
Changing the setting updates mounted history and nested thinking rows.

The field uses the existing host-owned settings JSON; no database migration or
schema/protocol version change is required. It does not alter provider thinking
levels, runtime/model context, stored reasoning, export, permissions, or copy
payloads. Process durations use message/tool timestamps and recorded durations;
a live UI clock adds no persisted fields. Step counts include rendered thinking,
tool and intermediate-text items and omit hidden compact-mode thinking.

## Consequences

- One completed turn has one process disclosure plus its visible answer.
- Reasoning remains available by switching back to detailed mode.
- Unchanged activity groups keep their memoized boundary during text deltas;
  the process wrapper does not move execution or persistence into the renderer.
- This groups loaded transcript entries; it does not reconstruct history that
  has not been loaded or join turns across compaction boundaries.

## Validation

`turn-process.test.mjs` covers projection, timing, partial/error answers and
legacy settings. `test:e2e:transcript` exercises real React/Chromium disclosure,
streaming, search, mode selection, mounted-history updates and the existing
100-group render boundary. `test:e2e:transcript-disclosure` retains the scroll
anchor gate; `test:e2e:theme-surfaces` checks the surrounding theme controls.
See E2E-CHAT-turn-process-and-thinking-display.
