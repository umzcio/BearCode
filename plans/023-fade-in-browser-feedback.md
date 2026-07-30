# 023 — Fade in browser lifecycle feedback

- **Status**: DONE
- **Commit**: `2117058`
- **Severity**: LOW
- **Category**: Continuity / Feedback
- **Estimated scope**: 3 files, roughly 45 lines

## Problem

Browser loading, idle, and error feedback is correctly withheld until the main process confirms that
the native `WebContentsView` is hidden:

```tsx
// src/renderer/src/components/Browser/BrowserPane.tsx:184 — current
const mayPaintFeedback = hideConfirmedRevision === presentationRevision
let feedback: React.ReactNode = null
if (mayPaintFeedback) {
  if (commandError) {
    feedback = <ErrorCard>{commandError}</ErrorCard>
  } else if (status === null || status.phase === 'starting') {
    feedback = (
      <div role="status" aria-live="polite" aria-atomic="true">
        <Loading label="Preparing browser…" />
      </div>
    )
  } else if (status.phase === 'idle') {
    feedback = <EmptyState title="Browser is not active" />
  } else if (status.phase === 'error') {
    feedback = <ErrorCard>{status.message ?? 'The browser could not be started.'}</ErrorCard>
  }
}

return (
  <div className="browser-pane" ref={ref}>
    {feedback ? <div className="browser-pane-state">{feedback}</div> : null}
  </div>
)
```

Once permission arrives, the feedback wrapper appears in a single frame. Its stylesheet provides
layout only:

```css
/* src/renderer/src/components/Browser/BrowserPane.css:10 — current */
.browser-pane-state {
  padding: 14px 16px;
}
```

The abrupt blank-to-status cut makes a carefully staged native-to-renderer handoff feel unfinished.
This is a safe continuity opportunity only after the authoritative hide gate has passed.

## Target

Give `.browser-pane-state` a 150ms opacity-only entry:

```css
/* src/renderer/src/components/Browser/BrowserPane.css — target */
.browser-pane-state {
  padding: 14px 16px;
  opacity: 1;
  transition: opacity var(--dur-fast) var(--ease-out);
}

@starting-style {
  .browser-pane-state {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .browser-pane-state {
    transition: none;
  }
}

:root[data-motion='reduced'] .browser-pane-state {
  transition: none;
}
```

There is no transform, exit animation, crossfade, delay, or overlap with native pixels. The
feedback node must still mount only when
`hideConfirmedRevision === presentationRevision`. If the feedback changes between loading, idle,
and error while the same wrapper remains mounted, do not restart the entry.

## Repo conventions to follow

- `src/renderer/src/components/Browser/BrowserPane.tsx:121-204` treats the hide revision as
  authoritative permission to paint. Preserve the revision gate exactly.
- `src/renderer/src/components/ArtifactsPane.css:339-353` uses
  `@starting-style`, `var(--dur-fast)`, and `var(--ease-out)` for a small feedback entrance. Copy
  its opacity-entry structure, but omit transform for the native browser surface.
- `src/renderer/src/styles/tokens.css:63` defines `--dur-fast` as 150ms. Do not add browser-specific
  timing.
- Plan 019 makes live reduced-motion changes settle native-browser lifecycle state safely. Complete
  it before adding this cosmetic entry.

## Steps

1. Complete plan 019 and confirm the headed native-browser lifecycle gate passes.
2. In `src/renderer/src/components/Browser/BrowserPane.css`, add the exact opacity,
   `@starting-style`, OS-reduced, and in-app-reduced rules above. Keep the existing padding.
3. Do not change `BrowserPane.tsx` production markup or the `mayPaintFeedback` calculation.
4. In `src/main/artifactsPaneMotionContract.test.ts`, read `Browser/BrowserPane.css` alongside the
   pane stylesheet. Add rule-aware assertions for the base opacity `1`, exact
   `opacity var(--dur-fast) var(--ease-out)` transition, starting opacity `0`, absence of transform,
   and `transition: none` under both reduced-motion signals.
5. Extend `src/renderer/src/components/Browser/BrowserPane.test.tsx` only where needed to prove the
   wrapper does not exist before the matching hide confirmation and mounts once afterward. Change
   status within the same confirmed revision and assert the same `.browser-pane-state` DOM node is
   retained so the entry does not replay.
6. Run the focused tests, then the headed Electron browser suite to verify that no renderer
   feedback is visible over native browser pixels.

## Boundaries

- Do NOT weaken, move, or bypass `mayPaintFeedback`.
- Do NOT animate the native `WebContentsView`, its bounds, or the `.browser-pane` container.
- Do NOT use transform, blur, scale, a delay, an exit animation, or a feedback crossfade.
- Do NOT remount the wrapper solely because its child status changes.
- Do NOT exceed `var(--dur-fast)` (150ms).
- Do NOT add dependencies.
- If a step does not match commit `2117058` plus completed plan 019, STOP and report the drift
  instead of improvising.

## Verification

- **Mechanical**:
  - `npx vitest run src/renderer/src/components/Browser/BrowserPane.test.tsx src/main/artifactsPaneMotionContract.test.ts` exits 0.
  - `npx eslint src/renderer/src/components/Browser/BrowserPane.tsx src/renderer/src/components/Browser/BrowserPane.test.tsx src/main/artifactsPaneMotionContract.test.ts` exits 0.
  - `npm run typecheck` exits 0.
  - `npm run build` exits 0.
  - `npm run test:electron:browser` passes with no native/renderer overlap.
- **Feel check**: run the app and exercise browser starting, idle, and error states:
  - The browser area remains blank while a hide confirmation is outstanding.
  - After confirmation, feedback fades from 0 to 1 once in 150ms with no movement.
  - A loading-to-error or loading-to-idle update in the same presentation does not replay the fade.
  - Repeated target switching never exposes renderer feedback over live native pixels.
  - In DevTools, set playback to 10% and confirm the only animated property is opacity.
  - Toggle `prefers-reduced-motion` and the in-app setting separately; feedback appears immediately
    and remains readable.
- **Done when**: browser feedback receives one opacity-only entry after the authoritative hide,
  status updates do not remount it, reduced motion removes the transition, headed native ordering
  remains safe, and every command above passes.
