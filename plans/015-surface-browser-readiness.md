# Plan 015: Surface native browser readiness and failure states

> **Executor instructions**: Implement the explicit lifecycle below end-to-end across manager, IPC,
> preload, and renderer. Never show native pixels over a loading/error surface. Update the index.
>
> **Drift check (run first)**:
> `git diff --stat 102a212..HEAD -- src/main/browser/manager.ts src/main/ipc.ts src/preload/index.ts src/shared/types.ts src/renderer/src/components/Browser/BrowserPane.tsx src/renderer/src/components/Browser/BrowserPane.test.tsx src/renderer/src/components/Settings/pages/BrowserPage.tsx`

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/007-harden-browser-control-ipc.md`, `plans/012-add-headed-browser-harness.md`
- **Category**: direction
- **Planned at**: commit `102a212`, 2026-07-28

## Why this matters

`BrowserPane` is an empty placeholder. If Chromium is installing, CDP is disabled, attachment fails,
the page crashes, or no browser session exists, users see blank chrome with no explanation while
show/hide rejections are ignored. A typed, pushed lifecycle should keep the native view hidden until
ready and render accessible loading/idle/error feedback.

## Current state

- `BrowserPane.tsx:23-44` reports bounds and calls `show`/`hide` based only on shell settlement. It
  catches no IPC failure and renders `<div className="browser-pane" />`.
- `BrowserManager.status()` at `manager.ts:60-75` reports installed/connected/conversation/debugging
  but no phase or error.
- `BrowserManager.start()` at lines 81-109 can fail with actionable messages; callers see the tool
  error but the pane does not.
- `BrowserPage.tsx:97-119` duplicates the status type and fetches it once.
- Preload push-subscription precedent is `onEvent`/`onRunStateChange` at
  `preload/index.ts:521-534`; main broadcast precedent is `ipc.ts:184-199`.
- Use shared `Loading`, `EmptyState`, and `ErrorCard`; no bespoke raw states.

## Lifecycle contract

Add one shared `BrowserStatus`:

```ts
type BrowserPhase = 'idle' | 'starting' | 'ready' | 'error'
interface BrowserStatus {
  phase: BrowserPhase
  message: string | null
  installed: boolean
  connected: boolean
  conversationId: string | null
  debuggingEnabled: boolean
}
```

- `idle`: no live session; show an EmptyState.
- `starting`: hide native view; show Loading.
- `ready`: connected session; renderer may show native view after shell settlement.
- `error`: hide native view; show ErrorCard with manager’s sanitized actionable message.
- Every phase transition is broadcast; initial `status()` prevents subscription races.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Manager tests | `npx vitest run src/main/browser/manager.visibility.test.ts` | all pass |
| Preload tests | `npx vitest run src/preload/index.test.ts` | all pass |
| BrowserPane tests | `npx vitest run src/renderer/src/components/Browser/BrowserPane.test.tsx` | all pass |
| Headed harness | `npm run test:electron:browser` | all named assertions pass |
| Types | `npm run typecheck` | exit 0 |

## Scope

**In scope**:

- `src/shared/types.ts`
- `src/main/browser/manager.ts` and tests
- `src/main/ipc.ts` and browser-control tests
- `src/preload/index.ts` and tests
- `src/renderer/src/components/Browser/BrowserPane.tsx`, CSS, and tests
- `src/renderer/src/components/Settings/pages/BrowserPage.tsx`

**Out of scope**:

- Browser policy/session/navigation redesign
- Automatic retries or Chromium install UI controls
- Polling
- Showing native view before ready

## Git workflow

- Branch: `advisor/015-surface-browser-readiness`
- Commit: `feat: surface embedded browser readiness`

## Steps

### Step 1: Test manager phase transitions

With mocked ensureChromium/CDP/view dependencies, assert idle → starting → ready, start rejection →
error with sanitized first-line message, render-process-gone → error/idle per documented choice,
and teardown → idle. Assert listeners receive immutable snapshots and can unsubscribe.

**Verify**: tests fail against current status.

### Step 2: Implement shared status and push notifications

Move the status type to shared. Add a manager status-listener API and a single transition helper that
updates phase/message then notifies. Wrap `start()` so every failure records `error` before rethrow.
Successful start records ready only after page/CDP resolution. Normal teardown records idle; cleanup
performed as part of a failed start must not erase its error before observers see it.

In `registerIpc`, broadcast status changes. Add typed `browser.onStatus(cb): () => void` in
`BearcodeApi` and preload. Apply plan 007’s sender policy to the initial status invoke; push events
are main-to-renderer.

**Verify**: manager, IPC, and preload tests pass.

### Step 3: Render state and gate native visibility

`BrowserPane` subscribes first and invokes `status()` for current state with a stale/unmount guard.
It calls `show()` only when both props say settled/visible and status is ready/connected. All other
phases call hide before displaying renderer feedback.

Render:

- Loading “Preparing browser…” for starting/checking;
- EmptyState “Browser is not active” for idle;
- ErrorCard with the status message for error;
- an empty placeholder only for ready, because native pixels cover it.

Catch status/show/hide/setBounds rejections and convert current-call failure to an ErrorCard without
letting a stale rejection overwrite a newer ready status.

**Verify**: component tests cover each phase and native show/hide call order.

### Step 4: Reuse the shared type in Settings and run real harness

Remove `BrowserPage`’s duplicate type. Run all commands in the table.

## Test plan

Manager owns phase transitions; preload owns exact channel/listener cleanup; BrowserPane owns
accessible state and native-view gating; headed harness proves ready remains compatible with real
Electron. Include late initial-status resolution after a pushed newer status.

## Done criteria

- [ ] One shared typed status includes phase/message.
- [ ] Every manager start success/failure broadcasts.
- [ ] BrowserPane never shows native view outside ready+connected+settled.
- [ ] Idle/loading/error states are accessible shared primitives.
- [ ] IPC failures do not become unhandled promises or stale UI.
- [ ] Settings uses shared status.
- [ ] Unit, preload, renderer, headed, and type gates pass.
- [ ] Index updated.

## STOP conditions

- Manager start errors contain secrets or raw page content; sanitize at source before broadcasting.
- `registerIpc` can be called repeatedly in production and would leak status listeners.
- A status push can reach unauthorized windows; scope broadcast to authoritative app windows.
- Native view can remain visible above the renderer error despite `hide()` ordering.

## Maintenance notes

Phase is user-facing state, not a log of every internal step. Keep messages actionable and
secret-free; future phases require renderer exhaustiveness tests.
