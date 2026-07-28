# Plan 009: Maintain an incremental Artifacts event projection

> **Executor instructions**: This is a store-shape change. Follow test-first steps, update every
> constructor/load path, and stop rather than leaving dual sources inconsistent. Update the index.
>
> **Drift check (run first)**:
> `git diff --stat 102a212..HEAD -- src/renderer/src/state/store.ts src/renderer/src/state/store.test.ts src/renderer/src/lib/auxRail.ts src/renderer/src/lib/auxRail.test.ts src/renderer/src/components/ArtifactsPane.tsx`

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: `plans/002-characterize-diff-review.md`
- **Category**: perf
- **Planned at**: commit `102a212`, 2026-07-28

## Why this matters

Every streamed assistant-text update clones the conversation event array. The open Artifacts Pane
subscribes to that full array and re-filters it for rail entries, artifact versions, attachments,
pending plan calls, and the diff’s originating prompt—even when the update cannot affect any of
those results. Maintain a small incremental projection so unrelated streaming retains identity and
does not render the pane.

## Current state

- `store.ts:626-632` calls `mergeEvent(convo.events, event)` for every event.
- `mergeEvent.ts:6-15` preserves element identity but returns a new array, including tail streaming.
- `ArtifactsPane.tsx:163-174` selects `{ events: c.events }`, then lines 249-336 scan/filter it.
- `DiffPanel` separately selects full events at lines 492-520 to find the preceding `user_message`.
- The pane needs these event classes:
  - `artifact`;
  - `file_diff`;
  - `assistant_attachment`;
  - `user_message` (For-Turn prompt);
  - `tool_call` where `tool === 'submit_plan'` (live plan-review pairing).
- `Convo` is created in `fromMeta` (`store.ts:234-258`), hydrated at `openConvo`
  (`1047-1062`), and also constructed in tests.
- `auxRail.test.ts` is the pure projection behavior exemplar.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Projection tests | `npx vitest run src/renderer/src/lib/auxEvents.test.ts` | all pass |
| Store tests | `npx vitest run src/renderer/src/state/store.test.ts` | all pass |
| Pane tests | `npx vitest run src/renderer/src/components/ArtifactsPane.diff.test.tsx src/renderer/src/components/ArtifactsPane.test.tsx` | all pass |
| Web typecheck | `npm run typecheck:web` | exit 0 |

## Scope

**In scope**:

- `src/renderer/src/lib/auxEvents.ts` and `.test.ts` (create)
- `src/renderer/src/state/store.ts`
- Store test fixtures affected by the new `Convo` field
- `src/renderer/src/components/ArtifactsPane.tsx`
- Pane tests needed for render identity

**Out of scope**:

- Changing authoritative `Convo.events` or transcript rendering
- Optimizing `ContextMeter` or other event consumers
- Persisting a second database representation
- Omitting user messages or submit-plan calls to make the projection smaller

## Git workflow

- Branch: `advisor/009-stabilize-artifact-event-projection`
- Commit: `perf: project artifacts events incrementally`

## Steps

### Step 1: Define and test the projection contract

Create `auxEvents.ts` with:

- an `AuxEvent` union/type predicate for exactly the five classes above;
- `projectAuxEvents(events)` for one-time hydration;
- `mergeAuxEvent(previous, event)` that returns the exact `previous` reference for irrelevant events
  and otherwise uses event-id replacement semantics matching `mergeEvent`.

Test append/update ordering, a `submit_plan` update, an unrelated tool call, streaming
`assistant_text`, attachments, user messages, artifacts, and diffs.

**Verify**: pure tests pass.

### Step 2: Add a `Convo.auxEvents` read model

Add the field to `Convo`. Initialize it to `[]` in `fromMeta`. In `upsertEvent`, compute both
authoritative `events` and incremental `auxEvents`, preserving the previous projection reference for
irrelevant updates. On `conversations.get` hydration, derive it once from the loaded history in the
same `patchConvo` call as `events`.

Update typed test factories exhaustively. Do not make the field optional; optionality would push
fallback full-history scans back into render.

**Verify**: store tests prove:

- irrelevant streaming changes `events` identity but preserves `auxEvents` identity;
- a relevant update changes both appropriately;
- loaded history produces the same projection as the pure helper.

### Step 3: Point the pane exclusively at the projection

Replace both full-event subscriptions in `ArtifactsPane`/`DiffPanel` with the projected field.
Continue passing the projected array to `deriveRailEntries`, `versionsOfType`, attachment lookup,
pending-plan pairing, and For-Turn lookup; it contains every required class.

Add a component render-count test showing streamed `assistant_text` updates do not rerender a stable
pane, while a new diff/artifact does.

**Verify**: all pane behavior tests pass.

### Step 4: Run checks

Run the commands in the table and scoped lint on the changed files.

## Test plan

Pure tests own event inclusion and merge identity. Store tests own hydration/update wiring.
Component tests own the user-visible behavior and no-rerender guarantee. Test a re-emitted
`submit_plan` approval-state update so the plan action surface still disappears correctly.

## Done criteria

- [ ] `Convo.events` remains authoritative and unchanged in semantics.
- [ ] Irrelevant streamed updates preserve `auxEvents` by reference.
- [ ] All five required event classes project correctly.
- [ ] Hydration and live updates use the same contract.
- [ ] Pane behavior and render-count tests pass.
- [ ] Web typecheck/lint pass; index updated.

## STOP conditions

- Another Artifacts Pane behavior needs an event class not listed above; add it explicitly and test
  it rather than reaching back to full events.
- Live events can arrive before a `Convo` exists and must be buffered elsewhere.
- The projection diverges from authoritative event-id replacement semantics.

## Maintenance notes

When adding a pane feature that consumes another event type, update `AuxEvent` and its tests first.
The optimization depends on a complete, explicit dependency list.
