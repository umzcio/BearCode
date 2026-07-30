# 019 — React to live reduced-motion changes

- **Status**: DONE
- **Commit**: `2117058`
- **Severity**: MEDIUM
- **Category**: Accessibility / Interruptibility
- **Estimated scope**: 5 files, roughly 120 lines

## Problem

The Artifacts Pane samples reduced motion only when its `open` prop changes. The browser presentation
gate therefore does not react when the OS preference or the in-app setting changes during the
340ms drawer transition:

```tsx
// src/renderer/src/components/ArtifactsPane.tsx:109 — current
const [motion, setMotion] = useState(() => ({
  open,
  settled: open && prefersReducedMotion()
}))
if (motion.open !== open) {
  setMotion({ open, settled: open && prefersReducedMotion() })
}

const renderedTarget = nextPresentation.displayed
if (!mounted || !renderedTarget) return null
const onTransitionEnd = (event: React.TransitionEvent<HTMLDivElement>): void => {
  if (event.target !== event.currentTarget || event.propertyName !== 'transform') return
  if (state === 'closing') {
    completeExit()
  } else {
    setMotion({ open: true, settled: true })
  }
}
```

The CSS switches the panel from a transform transition to an opacity transition as soon as the OS
preference changes:

```css
/* src/renderer/src/components/ArtifactsPane.css:21 — current */
@media (prefers-reduced-motion: reduce) {
  .ap-panel {
    transition: opacity var(--dur-fast) ease;
    transform: none;
    opacity: 1;
  }
  @starting-style {
    .ap-panel {
      transform: none;
      opacity: 0;
    }
  }
  .ap-panel[data-state='closing'] {
    transform: none;
    opacity: 0;
  }
}
```

`useAnimatedUnmount` has the same one-shot sampling behavior on close:

```ts
// src/renderer/src/lib/useAnimatedUnmount.ts:42 — current
if (open !== s.open) {
  if (open) {
    setS({ open, mounted: true, phase: 'open' })
  } else {
    const skipExit = immediate || prefersReducedMotion()
    setS({ open, mounted: !skipExit, phase: 'closing' })
  }
}
```

If Reduce Motion becomes active after a normal transition begins, the browser can remain gated
behind `motion.settled === false`, and a closing shell can wait for the two-second signal failsafe.
Browsers may emit `transitioncancel`, not the watched `transform` `transitionend`, when the media
query replaces the transition. The UI then feels stuck precisely when the user asks it to stop
moving.

## Target

Make the combined OS and in-app reduced-motion preference an observable external store while
preserving the existing synchronous `prefersReducedMotion()` snapshot helper:

```ts
// src/renderer/src/lib/prefersReducedMotion.ts — target shape
import { useSyncExternalStore } from 'react'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

export function prefersReducedMotion(): boolean {
  const osReduced = window.matchMedia?.(REDUCED_MOTION_QUERY)?.matches ?? false
  const appReduced = document.documentElement.getAttribute('data-motion') === 'reduced'
  return osReduced || appReduced
}

function subscribeReducedMotion(onStoreChange: () => void): () => void {
  const media = window.matchMedia?.(REDUCED_MOTION_QUERY)
  media?.addEventListener('change', onStoreChange)

  const observer = new MutationObserver(onStoreChange)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-motion']
  })

  return () => {
    media?.removeEventListener('change', onStoreChange)
    observer.disconnect()
  }
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false)
}
```

Use the live boolean in both lifecycles:

- In `useAnimatedUnmount`, use it for the existing open-to-closing edge. If it becomes `true` while
  a signal-completed exit is already mounted and closing, synchronously change only `mounted` to
  `false`. Keep the two-second failsafe for genuine missing signals under normal motion.
- In `ArtifactsPane`, use it for the initial `settled` value and open-edge reset. If it becomes
  `true` while an open panel is not settled, mark the current open revision settled immediately so
  the native browser gate cannot remain stale.
- Add `onTransitionCancel` to `.ap-panel`, but accept a canceled `transform` as completion only when
  the live reduced-motion value is `true`. A normal cancellation caused by reversal or retargeting
  must not settle a stale presentation.

The existing motion values do not change: normal drawer movement remains
`transform var(--dur-drawer) var(--ease-drawer)` (340ms), and OS-reduced feedback remains
`opacity var(--dur-fast) ease` (150ms). Do not add a timer that mirrors either duration.

## Repo conventions to follow

- `src/renderer/src/lib/prefersReducedMotion.ts:1-12` is the single source of truth for the combined
  OS and `data-motion="reduced"` snapshot. Extend this module instead of introducing a second query.
- `src/renderer/src/lib/heightAnimator.ts` already reads reduced motion during an active run and
  snaps to its endpoint; the panel lifecycle should provide the same interruptibility.
- `src/renderer/src/components/ArtifactsPane.tsx:106-145` deliberately keeps native
  `WebContentsView` pixels hidden until renderer geometry is safe. Preserve this gate.
- `src/renderer/src/styles/tokens.css:123-132` collapses in-app transition durations globally, while
  movement-bearing components explicitly remove transforms. Do not alter the global rule.

## Steps

1. In `src/renderer/src/lib/prefersReducedMotion.ts`, add the
   `useSyncExternalStore`-backed `usePrefersReducedMotion()` hook shown above. Subscribe to the
   media-query `change` event and a `MutationObserver` limited to the root `data-motion` attribute.
   Remove both subscriptions in the returned cleanup.
2. Extend `src/renderer/src/lib/prefersReducedMotion.test.ts` with a stable `MediaQueryList` fake
   whose `matches` value can change and whose registered listeners can be emitted. Cover an OS
   change, an in-app attribute mutation, the OR behavior when one signal remains active, and
   listener/observer cleanup after unmount.
3. In `src/renderer/src/lib/useAnimatedUnmount.ts`, replace direct one-shot use with the live hook.
   Preserve the render-time open-edge adjustment. Add one guarded adjustment for
   `reducedMotion && s.phase === 'closing' && s.mounted` so an already-running close unmounts
   immediately.
4. Extend `src/renderer/src/lib/useAnimatedUnmount.test.ts` to start a signal-completed close under
   normal motion, then activate the OS signal and the in-app signal in separate tests. Each must
   unmount before the 2000ms failsafe. Retain coverage proving normal signal mode still waits.
5. In `src/renderer/src/components/ArtifactsPane.tsx`, read `usePrefersReducedMotion()`, use it for
   initialization/open-edge state, and settle an already-open unresolved motion revision when the
   value becomes true. Route `transitionend` and reduced-motion `transitioncancel` through the same
   current-state completion helper, retaining the self-target and `propertyName === 'transform'`
   guards.
6. Extend `src/renderer/src/components/ArtifactsPane.test.tsx` with live-toggle cases. For a browser
   opening under normal motion, verify native visibility stays false before the signal and becomes
   true when OS reduction is emitted without a `transitionend`. For closing, verify either reduced
   signal removes the retained shell immediately. Verify a `transitioncancel` under normal motion
   is ignored.
7. Run the focused and repository gates below. Exercise the native browser path in the headed
   harness because jsdom cannot validate `WebContentsView` pixel ordering.

## Boundaries

- Do NOT change drawer, opacity, or failsafe durations.
- Do NOT show a native browser before final renderer bounds are available.
- Do NOT treat every `transitioncancel` as successful completion.
- Do NOT remove the existing two-second signal failsafe.
- Do NOT alter global appearance persistence or `data-motion` application.
- Do NOT add dependencies.
- If a step does not match commit `2117058`, STOP and report the drift instead of improvising.

## Verification

- **Mechanical**:
  - `npx vitest run src/renderer/src/lib/prefersReducedMotion.test.ts src/renderer/src/lib/useAnimatedUnmount.test.ts src/renderer/src/components/ArtifactsPane.test.tsx` exits 0.
  - `npx eslint src/renderer/src/lib/prefersReducedMotion.ts src/renderer/src/lib/prefersReducedMotion.test.ts src/renderer/src/lib/useAnimatedUnmount.ts src/renderer/src/lib/useAnimatedUnmount.test.ts src/renderer/src/components/ArtifactsPane.tsx src/renderer/src/components/ArtifactsPane.test.tsx` exits 0.
  - `npm run typecheck` exits 0.
  - `npm run build` exits 0.
  - `npm run test:electron:browser` passes the native-browser lifecycle suite.
- **Feel check**: run the app, open the Artifacts Pane onto a browser artifact, and confirm:
  - Turning on OS Reduce Motion midway through opening stops positional movement immediately and
    reveals the browser only after its bounds are stable.
  - Turning on the in-app setting midway through closing removes the retained shell immediately;
    there is no two-second ghost pane.
  - Rapid open/close/reopen still settles the current presentation only, with no browser flash.
  - In DevTools, set playback to 10% and confirm a normal cancellation/reversal does not reveal a
    stale native browser.
  - Toggle `prefers-reduced-motion` in the Rendering panel and confirm movement is dropped while the
    existing 150ms opacity feedback remains.
- **Done when**: both reduced-motion signals are observable, active open and close lifecycles snap
  safely when either turns on, normal transition cancellation remains guarded, native browser
  ordering is unchanged, and every command above passes.
