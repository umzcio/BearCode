# Plan 010: Make Monaco comment motion preference-live and target-stable

> **Executor instructions**: Follow test-first steps. Preserve the approved bounded view-zone
> exception; do not replace it with overlaying code. Update the index on completion.
>
> **Drift check (run first)**:
> `git diff --stat 102a212..HEAD -- src/renderer/src/components/monacoCommon.ts src/renderer/src/components/monacoCommon.test.ts src/renderer/src/lib/heightAnimator.ts src/renderer/src/lib/heightAnimator.test.ts src/renderer/src/lib/prefersReducedMotion.ts`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/001-restore-static-gate.md`
- **Category**: bug
- **Planned at**: commit `102a212`, 2026-07-28

## Why this matters

The inline composer samples reduced motion only when Monaco commenting attaches. Changing the
in-app or OS preference while an editor is open has no effect. Every input event also retargets the
zone animator even when measured height did not change, repeatedly restarting the same animation.
The animator should read preference live and ignore an already-active identical target.

## Current state

`monacoCommon.ts:156-167` constructs:

```ts
createHeightAnimator({
  durationMs: readCssTimeMs('--dur-menu'),
  curve: readCssCubicBezier('--ease-out'),
  reduced: prefersReducedMotion(),
  apply: ...
})
```

`relayout()` at lines 242-250 calls `animator.retarget(bar.offsetHeight + 12)`, and `ta.oninput`
calls `relayout()` for every keystroke. `heightAnimator.ts:40-66` cancels the current frame before it
checks whether the requested height equals current height; it does not remember the active target.

`applyAppearance()` dispatches `bearcode:appearance` after changing `data-motion`, and OS preference
is available through `matchMedia`. A live getter is enough if the animator checks it on each target
and frame; no React hook is needed.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Animator tests | `npx vitest run src/renderer/src/lib/heightAnimator.test.ts` | all pass |
| Monaco tests | `npx vitest run src/renderer/src/components/monacoCommon.test.ts` | all pass |
| Web typecheck | `npm run typecheck:web` | exit 0 |
| Lint | `npx eslint src/renderer/src/lib/heightAnimator.ts src/renderer/src/components/monacoCommon.ts` | exit 0 |

## Scope

**In scope**:

- `src/renderer/src/lib/heightAnimator.ts` and `.test.ts`
- `src/renderer/src/components/monacoCommon.ts` and `.test.ts`

**Out of scope**:

- Changing duration/easing tokens or comment UI
- Removing the Monaco view-zone height animation
- Global refactor of other reduced-motion consumers
- CSS motion changes

## Git workflow

- Branch: `advisor/010-fix-monaco-comment-retargeting`
- Commit: `fix: stabilize monaco comment motion`

## Steps

### Step 1: Add animator regressions

Add tests proving:

1. Calling `retarget(100)` again while an animation toward 100 is active does not cancel, restart,
   allocate another frame, or delay completion.
2. Changing a live reduced getter from false to true during an active run makes the next frame snap
   to the target, clear pending frames, and invoke completion once.
3. A new different target still interrupts from current height.

**Verify**: first two tests fail before implementation.

### Step 2: Extend `HeightAnimator` with a live preference and target memory

Allow `reduced` to be either a boolean or `() => boolean` (or rename to an explicit getter while
keeping call sites simple). Resolve it at each retarget and animation tick. Track the active target
separately from current sampled height.

If the requested target equals the active target and a frame is pending, return without canceling.
If preference becomes reduced mid-flight, cancel further scheduling, apply the exact target, and
complete the latest run once. Preserve generation-based stale completion protection.

**Verify**: all animator tests pass.

### Step 3: Wire Monaco to live preference and avoid redundant layout work

Pass `prefersReducedMotion` as a getter, not its sampled result. In `relayout`, measure the next
height once. Rely on animator target stability and optionally cache the last measured target so
`positionOverlay` can still update without a height retarget.

Extend the fake editor test to type multiple same-height values and assert `layoutZone`/frame
scheduling does not restart. Toggle `data-motion` during an active expansion and assert it snaps.
If testing OS change, use a mutable `matchMedia` stub.

**Verify**: Monaco tests pass.

### Step 4: Run checks

Run the command table.

## Test plan

Test same target while active, same target after completion, different target, preference change
mid-open, preference change mid-close, and disposal. Existing interruptible open/close tests must
remain.

## Done criteria

- [ ] Reduced motion is read live, not captured at editor attachment.
- [ ] Identical active targets do not restart animation.
- [ ] Mid-flight reduction snaps and completes exactly once.
- [ ] Different-height growth remains interruptible.
- [ ] Disposal leaves no frames.
- [ ] Tests/typecheck/lint pass; index updated.

## STOP conditions

- The animator has another caller that requires identical retarget to replace its completion
  callback. Preserve compatibility or introduce an explicit option.
- OS preference cannot be observed through the existing getter in the target Electron runtime.
- Same-height suppression prevents overlay scroll positioning; keep positioning separate.

## Maintenance notes

`current()` and active target are different concepts. Future callers should not infer that an
in-flight current height equals its destination.
