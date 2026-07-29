# 021 — Deduplicate Monaco comment-button pointer writes

- **Status**: DONE
- **Commit**: `2117058`
- **Severity**: LOW
- **Category**: Performance
- **Estimated scope**: 2 files, roughly 55 lines

## Problem

Every Monaco `mousemove` event recomputes the line offset and writes `top` and `display`, even when
the pointer is still on the same rendered line:

```ts
// src/renderer/src/components/monacoCommon.ts:304 — current
let fabLine = 0

const hideFab = (): void => {
  fab.style.display = 'none'
}
const move = ed.onMouseMove((e) => {
  const pos = e.target.position
  if (!pos) return
  fabLine = pos.lineNumber
  fab.style.top = `${ed.getTopForLineNumber(fabLine) - ed.getScrollTop()}px`
  fab.style.display = 'flex'
})
```

Pointer streams can fire many times per frame. Repeating layout reads and style writes for the same
line adds avoidable work to a code surface that is already measuring Monaco view zones. The button
does not need per-pixel tracking; its target changes only when the hovered line changes or after a
scroll invalidates its previous position.

## Target

Track both the active line and whether the FAB is visible. Update position only for a new visible
line, or when a previously hidden button must be shown again:

```ts
// src/renderer/src/components/monacoCommon.ts — target shape
let fabLine = 0
let fabVisible = false

const hideFab = (): void => {
  if (!fabVisible) return
  fabVisible = false
  fab.style.display = 'none'
}

const showFabForLine = (lineNumber: number): void => {
  if (fabVisible && fabLine === lineNumber) return

  fabLine = lineNumber
  fab.style.top = `${ed.getTopForLineNumber(lineNumber) - ed.getScrollTop()}px`
  fab.style.display = 'flex'
  fabVisible = true
  fab.setAttribute('aria-label', `Comment on line ${lineNumber}`)
}

const move = ed.onMouseMove((event) => {
  const lineNumber = event.target.position?.lineNumber
  if (lineNumber === undefined) return
  showFabForLine(lineNumber)
})
```

Keep `top` positioning. Do not convert it to `transform`, because plan 022 uses transform exclusively
for press acknowledgment. `onDidScrollChange` must continue to hide the FAB; the next pointer event
then recomputes the same line against the new scroll offset.

## Repo conventions to follow

- Plan 020 establishes the FAB's `aria-label`; the cached update helper must remain the only place
  that changes the visible line and its label.
- `src/renderer/src/components/monacoCommon.ts:320-323` already invalidates the FAB on scroll and
  repositions the separate comment overlay. Preserve both operations.
- `src/renderer/src/lib/heightAnimator.ts` avoids restarting a run when the target is unchanged.
  Apply that same target-stability principle to the FAB without introducing animation.

## Steps

1. Complete plan 020 first so the visible-target update includes its accessible line label.
2. In `src/renderer/src/components/monacoCommon.ts`, add `fabVisible` and the exact guarded
   `hideFab()` / `showFabForLine()` helpers above. Route `onMouseMove` through the show helper.
3. Keep `mouseleave`, scroll, click, and disposal behavior unchanged. A scroll and FAB click must
   set the visibility flag false through `hideFab()`, so the same line can be positioned again.
4. Extend the fake editor in `src/renderer/src/components/monacoCommon.test.ts` to capture
   `onMouseMove` and `onDidScrollChange` callbacks and spy on `getTopForLineNumber`.
5. Add a test that emits several moves on one line and asserts one position read, one computed
   `top`, and a visible button. Moving to a new line must perform exactly one additional position
   read and update the line label.
6. Add a scroll invalidation test: show line 7, change scroll position, emit the scroll callback,
   verify the button is hidden, then emit line 7 again and verify one new position read with the
   updated top. Repeated hide signals while already hidden must remain harmless.

## Boundaries

- Do NOT add `requestAnimationFrame`, throttling dependencies, or timers.
- Do NOT animate the FAB between lines.
- Do NOT move positioning from `top` to `transform`.
- Do NOT cache across a scroll; hiding must invalidate the visible position.
- Do NOT change composer targeting, click behavior, or Monaco view-zone motion.
- Do NOT add dependencies.
- If a step does not match commit `2117058` plus completed plan 020, STOP and report the drift
  instead of improvising.

## Verification

- **Mechanical**:
  - `npx vitest run src/renderer/src/components/monacoCommon.test.ts` exits 0.
  - `npx eslint src/renderer/src/components/monacoCommon.ts src/renderer/src/components/monacoCommon.test.ts` exits 0.
  - `npm run typecheck` exits 0.
  - `npm run build` exits 0.
- **Feel check**: run the app with a long diff and confirm:
  - Moving within one line keeps the FAB visually fixed and does not flicker.
  - Crossing line boundaries retargets immediately; clicking always comments the displayed line.
  - Scrolling hides the FAB, and the next pointer move places it correctly for the new scroll
    position.
  - In the Performance panel, a dense same-line pointer trace no longer shows repeated
    `getTopForLineNumber` work or identical `top` writes.
  - In DevTools, set playback to 10% and confirm there is no new positional animation or lag.
  - Toggle `prefers-reduced-motion` and confirm behavior is identical because this is
    de-duplication, not new motion.
- **Done when**: a visible line produces at most one position update until the line or scroll state
  changes, accessibility metadata stays in sync, all existing interactions remain correct, and
  every command above passes.
