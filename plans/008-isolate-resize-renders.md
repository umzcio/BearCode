# Plan 008: Keep pane resizing out of the heavy Artifacts body

> **Executor instructions**: Run the drift check, follow steps, and verify render-count behavior
> before claiming completion. Update the index row.
>
> **Drift check (run first)**:
> `git diff --stat 102a212..HEAD -- src/renderer/src/components/ArtifactsPane.tsx src/renderer/src/components/ArtifactsPane.test.tsx src/renderer/src/components/ResizeHandle.tsx src/renderer/src/state/store.ts`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/002-characterize-diff-review.md`
- **Category**: perf
- **Planned at**: commit `102a212`, 2026-07-28

## Why this matters

`ResizeHandle` intentionally dispatches at most once per animation frame, but every dispatch writes
`auxPaneWidth` to Zustand. `ArtifactsPane` subscribes to that width, so the entire 800-line pane
subtree—including Monaco wrappers and rail projections—is eligible to render on every drag frame.
The shell must resize continuously while stable content renders zero extra times.

## Current state

- `ResizeHandle.tsx:31-43` batches mouse deltas with requestAnimationFrame; preserve this.
- `App.tsx:179-184` calls `setAuxPaneWidth(..., { persist: false })` per frame and persists on end.
- `store.ts:914-917` always calls `set({ auxPaneWidth: c })`, even when rounding/clamping yields the
  existing width.
- `ArtifactsPane.tsx:91-131` subscribes to width and passes it only to the shell’s `flexBasis`.
- `ArtifactsPaneInner` receives only `target` and `browserVisible`; those values remain referentially
  stable during a drag.
- Memoized event components such as `components/events/DiffCard.tsx:10,67` are the repository
  precedent for isolating stable subtrees.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Pane tests | `npx vitest run src/renderer/src/components/ArtifactsPane.test.tsx` | all pass |
| Resize tests | `npx vitest run src/renderer/src/components/ResizeHandle.test.tsx` | all pass |
| Store tests | `npx vitest run src/renderer/src/state/store.test.ts -t "pane width"` | all pass |
| Web typecheck | `npm run typecheck:web` | exit 0 |

## Scope

**In scope**:

- `src/renderer/src/components/ArtifactsPane.tsx`
- `src/renderer/src/components/ArtifactsPane.test.tsx`
- `src/renderer/src/state/store.ts`
- `src/renderer/src/state/store.test.ts`

**Out of scope**:

- Replacing mouse events with pointer events
- Changing min/max widths or persistence timing
- Direct DOM mutation/CSS-variable resize architecture unless memoization cannot meet the render
  criterion
- Monaco’s own layout work after its container actually changes size

## Git workflow

- Branch: `advisor/008-isolate-resize-renders`
- Commit: `perf: isolate artifacts pane resize renders`

## Steps

### Step 1: Add a render-count regression

In `ArtifactsPane.test.tsx`, render a stable diff or attachment body through a mocked child that
increments a counter. Update `auxPaneWidth` several times inside `act`. Assert:

- shell `flexBasis` reflects the final width;
- the shell is the same DOM node;
- the inner/body mock rendered once.

Also add a store test proving two inputs that clamp/round to the current width preserve state and do
not notify a width subscriber.

**Verify**: the body render-count case fails before production changes.

### Step 2: Memoize the stable body boundary

Wrap `ArtifactsPaneInner` in `memo` (use a named implementation for readable stacks). Rely on normal
shallow prop comparison; do not write a custom comparator that can miss target changes. Ensure no
inline object/function prop is introduced from the width-owning outer component.

Keep `.ap-panel` persistent and keep browser settle/visibility state in the outer shell. The approved
motion design requires the shell, not its contents, to own transition completion.

**Verify**: body render count remains one while flexBasis changes.

### Step 3: Suppress no-op width writes

In `setAuxPaneWidth`, compare the clamped rounded value with `s.auxPaneWidth`. Persist only when the
caller requests persistence, but return the existing state for an unchanged value. Preserve the
current `{ persist: false }` drag behavior and end-of-drag storage write.

**Verify**: store no-op subscription test and existing clamp/persistence tests pass.

### Step 4: Run checks

Run all commands in the table and the diff characterization file.

## Test plan

The render counter must live inside the memoized boundary, not on the shell. Include one control
assertion showing a real target change does render new body content, so the test cannot pass because
updates are disconnected.

## Done criteria

- [ ] Width changes update the shell continuously.
- [ ] Stable Artifacts body renders zero additional times during width-only updates.
- [ ] Real target changes still render.
- [ ] Rounded/clamped no-op width writes notify no subscribers.
- [ ] Existing ResizeHandle rAF and persistence tests pass.
- [ ] Typecheck/lint pass and index updated.

## STOP conditions

- A stable body prop changes identity every drag frame for a legitimate reason.
- Browser bounds stop tracking resized geometry.
- Memoization hides a selected-target update in the control test.

## Maintenance notes

Do not add width to inner component props later. Monaco will still perform its necessary internal
layout when the container changes, but React should not rebuild its wrapper tree.
