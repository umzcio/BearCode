# 022 — Add press feedback to the Monaco comment button

- **Status**: DONE
- **Commit**: `2117058`
- **Severity**: LOW
- **Category**: Physicality / Cohesion
- **Estimated scope**: 2 files, roughly 30 lines

## Problem

The floating Monaco comment affordance is a real button:

```ts
// src/renderer/src/components/monacoCommon.ts:298 — current
const fab = document.createElement('button')
fab.className = 'comment-fab'
fab.innerHTML = FAB_SVG
fab.style.display = 'none'
container.appendChild(fab)
```

However, `.comment-fab` is omitted from the Artifacts Pane's shared press vocabulary:

```css
/* src/renderer/src/components/ArtifactsPane.css:932 — current */
:is(
  .ap-actions button,
  .ap-segmented button,
  .ap-rail-item,
  .ap-tab,
  .version-chip,
  .overview-file,
  .plan-review-actions button,
  .comment-composer-actions button,
  .comment-bar-send,
  .comment-bar-close,
  .comment-del,
  .foot-btn
) {
  transition:
    background-color var(--dur-fast) ease,
    color var(--dur-fast) ease,
    border-color var(--dur-fast) ease,
    transform var(--dur-press-release) var(--ease-out);
}
```

All neighboring review controls acknowledge a press with a small physical contraction, while this
primary line-comment action remains visually inert. The inconsistency makes the button feel less
connected to the rest of the pane.

## Target

Add `.comment-fab` to the shared base, active, OS-reduced, and in-app-reduced selector lists. It must
inherit the exact existing contract:

```css
/* target declarations inherited by .comment-fab */
transition:
  background-color var(--dur-fast) ease,
  color var(--dur-fast) ease,
  border-color var(--dur-fast) ease,
  transform var(--dur-press-release) var(--ease-out);

:active:not(:disabled) {
  transform: scale(0.97);
  transition:
    background-color var(--dur-fast) ease,
    color var(--dur-fast) ease,
    border-color var(--dur-fast) ease,
    transform var(--dur-press) var(--ease-out);
}
```

The release uses `--dur-press-release` (100ms); the active press uses `--dur-press` (140ms); both
use `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`. Under either reduced-motion signal,
`.comment-fab:active:not(:disabled)` must have `transform: none`.

Do not animate FAB appearance or line changes. Plan 021 deliberately retains `top` for positioning
so press scale owns the transform property without composition conflicts.

## Repo conventions to follow

- `src/renderer/src/styles/tokens.css:52-66` defines all required duration and easing tokens. Add no
  new token or hardcoded duration.
- `src/renderer/src/components/ArtifactsPane.css:930-1023` is the single shared press contract for
  this pane. Extend its family lists instead of adding a separate FAB rule.
- `src/main/artifactsPaneMotionContract.test.ts:9-22` keeps the authoritative
  `pressableFamilies` checklist and asserts that each family occurs in base, active, and both
  reduced-motion rules.

## Steps

1. Complete plans 020 and 021 first so the accessible target lifecycle is stable and FAB
   positioning does not use transform.
2. In `src/renderer/src/components/ArtifactsPane.css`, add `.comment-fab` to the shared base
   `:is(...)`, active `:is(...):active:not(:disabled)`, OS reduced active list, and in-app reduced
   active list. Do not add it to the disabled-only list because this generated control has no
   disabled state.
3. In `src/main/artifactsPaneMotionContract.test.ts`, add `.comment-fab` to
   `pressableFamilies`. The existing family assertions must then prove it receives the base,
   active, OS-reduced, and in-app-reduced declarations.
4. Add a focused assertion that the FAB is absent from any positioning transform rule; its only
   non-reduced transform must be the shared `scale(0.97)` active rule.
5. Run the focused contract, then typecheck and build.

## Boundaries

- Do NOT create a standalone `.comment-fab:active` motion vocabulary.
- Do NOT change the exact 0.97 scale, 140ms press, or 100ms release values.
- Do NOT animate FAB entrance, exit, `top`, or line retargeting.
- Do NOT add the FAB to the disabled list unless production code first gains a real disabled state.
- Do NOT change tooltip opacity motion in this plan.
- Do NOT add dependencies.
- If a step does not match commit `2117058` plus completed plans 020-021, STOP and report the drift
  instead of improvising.

## Verification

- **Mechanical**:
  - `npx vitest run src/main/artifactsPaneMotionContract.test.ts src/renderer/src/components/monacoCommon.test.ts` exits 0.
  - `npx eslint src/main/artifactsPaneMotionContract.test.ts` exits 0.
  - `npm run typecheck` exits 0.
  - `npm run build` exits 0.
- **Feel check**: run the app, reveal the comment FAB over a diff line, and confirm:
  - Pointer-down contracts the button subtly to 0.97 and release returns it without overshoot.
  - The FAB remains pinned to the same line and right edge throughout the press.
  - Clicking rapidly never compounds scale or delays opening the composer.
  - In DevTools, set playback to 10% and confirm the press uses 140ms and release uses 100ms with
    the shared strong ease-out.
  - Toggle `prefers-reduced-motion` and the in-app Reduce Motion setting separately; both remove
    scale while the comment action remains immediate.
- **Done when**: the FAB participates in every applicable shared press rule, reduced motion removes
  its scale, no positioning transform is introduced, the contract test enforces the family, and
  every command above passes.
