# Artifacts Pane Motion Polish Implementation Plan

> **Implementation status (2026-07-28):** Complete. The checked steps below preserve the original
> red-green implementation record. Current verification results supersede historical counts and
> commands where explicitly noted in Task 8.

**Goal:** Make Artifacts Pane motion lifecycle-correct, native-browser-safe, reduced-motion-complete, and consistently polished across controls, comments, review resolution, and preview arrival.

**Architecture:** Keep one renderer-owned `.ap-panel` shell mounted for the pane's entire open lifetime and complete its exit from the shell's own `transitionend` event. Treat the Electron `WebContentsView` as separately staged native pixels, use focused dependency-free helpers for CSS-token-driven Monaco height motion, and keep the remaining continuity effects in CSS plus small React state machines.

**Tech Stack:** React 19, TypeScript, Zustand, Monaco Editor, Electron `WebContentsView`, CSS custom properties/`@starting-style`, Vitest, Testing Library, requestAnimationFrame.

## Global Constraints

- Preserve `--dur-drawer: 340ms` and `--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1)` for actual pane open and close only.
- Add no motion, spring, or runtime dependency.
- Do not send per-frame renderer-to-main IPC while the native browser view is staged.
- Do not animate high-frequency diff, artifact, file, tab, or preview-mode navigation.
- Remove positional motion for both `@media (prefers-reduced-motion: reduce)` and `:root[data-motion='reduced']`.
- Keep browser session lifetime, navigation policy, Playwright control, attachment verification, and preview sandboxing unchanged.
- Keep `useAnimatedUnmount` timer behavior as the default for every existing consumer.
- Use `--dur-fast`, `--dur-menu`, `--dur-press`, `--dur-press-release`, `--ease-out`, and `--ease-drawer`; do not add parallel hardcoded visible durations.
- Review resolution must not wait for acknowledgment animation, and preview content must not wait for its entry fade.
- Follow red-green-refactor for every production change and make one focused commit per task.

---

## File Structure

- `src/renderer/src/lib/useAnimatedUnmount.ts`: generic presence state with opt-in signal completion and a 2000ms non-visual fail-safe.
- `src/renderer/src/lib/useAnimatedUnmount.test.ts`: timer, signal, reopen, safety, and reduced-motion presence tests.
- `src/main/browser/manager.ts`: native-view requested visibility and hidden-bound staging.
- `src/main/browser/manager.visibility.test.ts`: unit contract for hidden bounds, stored geometry, show, hide, and view creation.
- `src/renderer/src/components/Browser/BrowserPane.tsx`: placeholder geometry observer with explicit `visible` staging.
- `src/renderer/src/components/Browser/BrowserPane.test.tsx`: renderer IPC ordering and cleanup tests.
- `src/renderer/src/components/ArtifactsPane.tsx`: persistent shell, settled-state coordination, and keyed inner content only.
- `src/renderer/src/components/ArtifactsPane.test.tsx`: shell identity, close completion, reopen, and native-browser staging integration tests.
- `src/renderer/src/components/ArtifactsPane.css`: drawer/reduced-motion parity, pane control feedback, acknowledgments, and comment-bar entry.
- `src/main/artifactsPaneMotionContract.test.ts`: source-level CSS contract for press feedback and both reduced-motion paths.
- `src/renderer/src/lib/motionTokens.ts`: strict CSS time and cubic-bezier readers plus cubic-bezier evaluation.
- `src/renderer/src/lib/motionTokens.test.ts`: parser and easing tests.
- `src/renderer/src/lib/heightAnimator.ts`: interruptible requestAnimationFrame scalar animation used by the Monaco zone.
- `src/renderer/src/lib/heightAnimator.test.ts`: open, close, retarget, snap, and disposal tests under a deterministic clock.
- `src/renderer/src/components/monacoCommon.ts`: wire the animator into comment-zone layout and cleanup.
- `src/renderer/src/components/monacoCommon.test.ts`: Monaco adapter tests for zone creation/removal and relayout.
- `src/renderer/src/components/ArtifactViewer.tsx`: pending-request guard and accessible success acknowledgment.
- `src/renderer/src/components/ArtifactViewer.test.tsx`: approval, feedback, failure, duplicate-submit, expiry, and artifact-switch tests.
- `src/renderer/src/components/FilePreview/PreviewEntry.tsx`: shared resolved-preview entry wrapper.
- `src/renderer/src/components/FilePreview/FilePreview.tsx`: wrap current-file resolved content.
- `src/renderer/src/components/AttachmentPreview/AttachmentPreview.tsx`: wrap current-attachment resolved content.
- `src/renderer/src/components/FilePreview/FilePreview.css`: shared 150ms opacity entry and reduced-motion override.
- Existing preview tests: assert the wrapper is limited to current resolved payloads.

---

### Task 1: Signal-completed presence

**Files:**
- Modify: `src/renderer/src/lib/useAnimatedUnmount.ts`
- Modify: `src/renderer/src/lib/useAnimatedUnmount.test.ts`

**Interfaces:**
- Consumes: `prefersReducedMotion(): boolean`.
- Produces:

```ts
interface AnimatedUnmountOptions {
  durationMs?: number
  immediate?: boolean
  exitCompletion?: 'timer' | 'signal'
}

interface AnimatedUnmountResult {
  mounted: boolean
  state: 'open' | 'closing'
  completeExit: () => void
}
```

- `exitCompletion` defaults to `'timer'`.
- Signal mode keeps a closing element mounted until `completeExit()` or the 2000ms fail-safe.
- `completeExit()` is a no-op after reopen and under any non-closing state.

- [x] **Step 1: Write the failing signal-completion tests**

Add tests that destructure fields rather than comparing the callback by identity:

```ts
it('keeps signal-completed exits mounted until completeExit is called', () => {
  const { result, rerender } = renderHook(
    ({ open }) => useAnimatedUnmount(open, { exitCompletion: 'signal' }),
    { initialProps: { open: true } }
  )
  rerender({ open: false })
  act(() => vi.advanceTimersByTime(340))
  expect(result.current.mounted).toBe(true)
  act(() => result.current.completeExit())
  expect(result.current.mounted).toBe(false)
})

it('ignores a stale completion after reopening', () => {
  const { result, rerender } = renderHook(
    ({ open }) => useAnimatedUnmount(open, { exitCompletion: 'signal' }),
    { initialProps: { open: true } }
  )
  rerender({ open: false })
  const completeClosingExit = result.current.completeExit
  rerender({ open: true })
  act(() => completeClosingExit())
  expect(result.current.mounted).toBe(true)
  expect(result.current.state).toBe('open')
})

it('fails safe after 2000ms when a signal never arrives', () => {
  const { result, rerender } = renderHook(
    ({ open }) => useAnimatedUnmount(open, { exitCompletion: 'signal' }),
    { initialProps: { open: true } }
  )
  rerender({ open: false })
  act(() => vi.advanceTimersByTime(1999))
  expect(result.current.mounted).toBe(true)
  act(() => vi.advanceTimersByTime(1))
  expect(result.current.mounted).toBe(false)
})
```

Update existing exact-object assertions to assert `mounted` and `state`, and add a reduced-motion signal test proving close is still immediate.

- [x] **Step 2: Run the presence test and verify red**

Run:

```bash
npx vitest run src/renderer/src/lib/useAnimatedUnmount.test.ts
```

Expected: FAIL because `exitCompletion` and `completeExit` do not exist and signal mode still uses the ordinary duration.

- [x] **Step 3: Implement signal completion with a stable callback**

Use a named safety constant that is not a visual duration:

```ts
import { useCallback, useEffect, useState } from 'react'

const DEFAULT_DURATION_MS = 220
const SIGNAL_FAILSAFE_MS = 2000

export function useAnimatedUnmount(
  open: boolean,
  opts?: AnimatedUnmountOptions
): AnimatedUnmountResult {
  const durationMs = opts?.durationMs ?? DEFAULT_DURATION_MS
  const exitCompletion = opts?.exitCompletion ?? 'timer'
  // existing edge-adjustment state stays intact

  const completeExit = useCallback(() => {
    setS((prev) =>
      prev.phase === 'closing' && prev.mounted ? { ...prev, mounted: false } : prev
    )
  }, [])

  useEffect(() => {
    if (s.phase !== 'closing' || !s.mounted) return
    const waitMs = exitCompletion === 'signal' ? SIGNAL_FAILSAFE_MS : durationMs
    const id = window.setTimeout(completeExit, waitMs)
    return () => window.clearTimeout(id)
  }, [completeExit, durationMs, exitCompletion, s.mounted, s.phase])

  return { mounted: s.mounted, state: s.phase, completeExit }
}
```

Keep the existing synchronous reduced-motion/immediate unmount path exactly where the open edge is processed.

- [x] **Step 4: Run the presence test and typecheck**

Run:

```bash
npx vitest run src/renderer/src/lib/useAnimatedUnmount.test.ts
npm run typecheck:web
```

Expected: both PASS; timer consumers still use their configured visible duration.

- [x] **Step 5: Commit**

```bash
git add src/renderer/src/lib/useAnimatedUnmount.ts src/renderer/src/lib/useAnimatedUnmount.test.ts
git commit -m "feat: support signal-completed pane exits"
```

---

### Task 2: Stage native browser pixels independently of renderer geometry

**Files:**
- Modify: `src/main/browser/manager.ts`
- Create: `src/main/browser/manager.visibility.test.ts`
- Modify: `src/renderer/src/components/Browser/BrowserPane.tsx`
- Create: `src/renderer/src/components/Browser/BrowserPane.test.tsx`

**Interfaces:**
- Consumes: existing `window.bearcode.browser.setBounds`, `.show`, and `.hide` IPC methods.
- Produces: `export class BrowserManager`; `BrowserPane({ visible }: { visible: boolean })`.
- `setBounds()` always stores final geometry but never reveals a hidden native view.
- `show()` applies stored geometry; `hide()` applies offscreen geometry.
- `start()` respects the last requested visibility and `teardown()` does not erase that request.

- [x] **Step 1: Write the failing main-process visibility tests**

Use an exported class and set a fake view through a narrow test cast:

```ts
const setBounds = vi.fn()
const manager = new BrowserManager()
;(manager as unknown as { view: { setBounds: typeof setBounds } | null }).view = { setBounds }

manager.setBounds({ x: 40, y: 20, width: 900, height: 700 })
expect(setBounds).toHaveBeenLastCalledWith({ x: -10000, y: 0, width: 900, height: 700 })

manager.show()
expect(setBounds).toHaveBeenLastCalledWith({ x: 40, y: 20, width: 900, height: 700 })

manager.hide()
expect(setBounds).toHaveBeenLastCalledWith({ x: -10000, y: 0, width: 900, height: 700 })
```

Also assert that another `setBounds()` after `hide()` updates stored width/height but remains offscreen, then `show()` uses the newest rectangle.

- [x] **Step 2: Run the main-process test and verify red**

Run:

```bash
npx vitest run src/main/browser/manager.visibility.test.ts
```

Expected: FAIL because `BrowserManager` is not exported and hidden state is not tracked.

- [x] **Step 3: Implement requested visibility in `BrowserManager`**

Add one state bit and one helper:

```ts
const hiddenBounds = (bounds: Bounds): Bounds => ({
  x: -10000,
  y: 0,
  width: bounds.width,
  height: bounds.height
})

export class BrowserManager {
  private visible = false

  private appliedBounds(): Bounds {
    return this.visible ? this.bounds : hiddenBounds(this.bounds)
  }

  setBounds(bounds: Bounds): void {
    this.bounds = bounds
    this.view?.setBounds(this.appliedBounds())
  }

  show(): void {
    this.visible = true
    this.view?.setBounds(this.bounds)
  }

  hide(): void {
    this.visible = false
    this.view?.setBounds(hiddenBounds(this.bounds))
  }
}
```

Change view creation to `this.view.setBounds(this.appliedBounds())`. Do not reset `visible` inside `teardown()`: `start()` begins with `teardown()`, so clearing it there would discard an already-mounted pane's show request.

- [x] **Step 4: Write the failing renderer ordering tests**

Stub `ResizeObserver` and the browser IPC:

```tsx
const setBounds = vi.fn().mockResolvedValue(undefined)
const show = vi.fn().mockResolvedValue(undefined)
const hide = vi.fn().mockResolvedValue(undefined)

const { rerender, unmount } = render(<BrowserPane visible={false} />)
expect(setBounds).toHaveBeenCalledTimes(1)
expect(show).not.toHaveBeenCalled()

rerender(<BrowserPane visible />)
await waitFor(() => expect(show).toHaveBeenCalledTimes(1))
expect(setBounds.mock.invocationCallOrder[0]).toBeLessThan(show.mock.invocationCallOrder[0])

rerender(<BrowserPane visible={false} />)
expect(hide).toHaveBeenCalledTimes(1)
unmount()
expect(hide).toHaveBeenCalledTimes(2)
```

Add a test whose mocked rect changes before `visible` becomes true and assert the final `setBounds()` occurs before `show()`.

- [x] **Step 5: Run the renderer test and verify red**

Run:

```bash
npx vitest run src/renderer/src/components/Browser/BrowserPane.test.tsx
```

Expected: FAIL because `BrowserPane` has no `visible` prop and always shows on mount.

- [x] **Step 6: Implement explicit placeholder staging**

Keep one effect for observer lifetime and one for visibility:

```tsx
export function BrowserPane({ visible }: { visible: boolean }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const pushBounds = useCallback(() => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    void window.bearcode.browser.setBounds({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    })
  }, [])

  useEffect(() => {
    pushBounds()
    const observer = new ResizeObserver(pushBounds)
    if (ref.current) observer.observe(ref.current)
    window.addEventListener('resize', pushBounds)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', pushBounds)
      void window.bearcode.browser.hide()
    }
  }, [pushBounds])

  useEffect(() => {
    if (!visible) {
      void window.bearcode.browser.hide()
      return
    }
    pushBounds()
    void window.bearcode.browser.show()
  }, [pushBounds, visible])

  return <div className="browser-pane" ref={ref} />
}
```

- [x] **Step 7: Run focused browser tests and typechecks**

Run:

```bash
npx vitest run src/main/browser/manager.visibility.test.ts src/main/browser/manager.test.ts src/renderer/src/components/Browser/BrowserPane.test.tsx
npm run typecheck
```

Expected: PASS; no existing browser lifecycle test changes behavior.

- [x] **Step 8: Commit**

```bash
git add src/main/browser/manager.ts src/main/browser/manager.visibility.test.ts src/renderer/src/components/Browser/BrowserPane.tsx src/renderer/src/components/Browser/BrowserPane.test.tsx
git commit -m "fix: stage native browser view with pane motion"
```

---

### Task 3: Keep one Artifacts Pane shell through navigation and complete exit from CSS

**Files:**
- Modify: `src/renderer/src/components/ArtifactsPane.tsx`
- Modify: `src/renderer/src/components/ArtifactsPane.test.tsx`

**Interfaces:**
- Consumes: `useAnimatedUnmount(open, { exitCompletion: 'signal' })`; `BrowserPane({ visible })`.
- Produces: one `.ap-panel` from the first open render until an eligible close `transitionend`.
- The shell listens only to its own `transform` transition; child transitions cannot settle or close it.
- `browserVisible` is true only when local content is browser, the shell is open, and the shell is settled.

- [x] **Step 1: Write failing shell identity and presence tests**

Add a reusable browser API fixture and use the existing `seedAttachmentSelection()` helper. Capture the actual node, then switch to a concrete file selection:

```tsx
const { container } = render(<ArtifactsPane />)
const shell = container.querySelector('.ap-panel')
expect(shell).not.toBeNull()

act(() =>
  useAppStore.setState({
    auxSelection: { kind: 'file', path: '/workspace/src/index.ts', line: 12 },
    auxPaneOpenTick: 1
  })
)
expect(container.querySelector('.ap-panel')).toBe(shell)
```

Cover attachment-to-file, diff-ID-to-diff-ID, and diff-to-artifact changes. Add close sequencing:

```tsx
fireEvent.click(screen.getByRole('button', { name: 'Close panel' }))
expect(container.querySelector('.ap-panel')).toBe(shell)

fireEvent.transitionEnd(shell as HTMLElement, { propertyName: 'opacity' })
expect(container.querySelector('.ap-panel')).toBe(shell)

fireEvent.transitionEnd(shell as HTMLElement, { propertyName: 'transform' })
expect(container.querySelector('.ap-panel')).toBeNull()
```

Add a child `transitionend` case using `fireEvent.transitionEnd(child, { propertyName: 'transform' })`, and a reopen-before-end case proving the shell remains mounted and `data-state="open"`.

- [x] **Step 2: Write failing browser-settle integration tests**

Seed browser as the first target and assert `show` is absent until the shell's own opening transform ends:

```tsx
const shell = container.querySelector('.ap-panel') as HTMLElement
expect(browserShow).not.toHaveBeenCalled()
fireEvent.transitionEnd(shell, { propertyName: 'transform' })
expect(browserSetBounds).toHaveBeenCalled()
expect(browserShow).toHaveBeenCalledTimes(1)
```

Then seed an artifact first, settle the shell, switch to browser, and assert it shows immediately without a second shell replacement. Switch away and assert `hide` is called.

- [x] **Step 3: Run the Artifacts Pane test and verify red**

Run:

```bash
npx vitest run src/renderer/src/components/ArtifactsPane.test.tsx
```

Expected: FAIL because keyed target components still own `.ap-panel`, close is timer-completed, and browser shows before the shell settles.

- [x] **Step 4: Move the shell to `ArtifactsPane`**

Delete `AUX_EXIT_MS`. Make the outer component own presence, last-target retention, width, and settle state:

```tsx
const { mounted, state, completeExit } = useAnimatedUnmount(Boolean(target), {
  exitCompletion: 'signal'
})
const open = Boolean(target)
const reduced = prefersReducedMotion()
const [openState, setOpenState] = useState({
  open,
  settled: open && reduced
})

if (open !== openState.open) {
  setOpenState({ open, settled: open ? reduced : false })
}

const onTransitionEnd = (event: React.TransitionEvent<HTMLDivElement>): void => {
  if (event.target !== event.currentTarget || event.propertyName !== 'transform') return
  if (state === 'closing') {
    completeExit()
  } else {
    setOpenState({ open: true, settled: true })
  }
}

const current = lastTarget.current
const contentKey =
  current.kind === 'file'
    ? `file:${current.path}:${current.line ?? ''}`
    : current.kind === 'attachment'
      ? `attachment:${current.conversationId}:${current.attachmentId}`
      : current.kind === 'diff'
        ? `diff:${current.diffId}`
        : current.kind === 'artifact'
          ? `artifact:${current.artifactId}`
          : 'browser'
const panelClassName =
  'ap-panel' + (current.kind === 'attachment' ? ' ap-attachment-panel' : '')

return (
  <div
    className={panelClassName}
    data-state={state}
    data-panel-kind={lastTarget.current.kind}
    style={{ flexBasis: auxPaneWidth }}
    onTransitionEnd={onTransitionEnd}
  >
    <ArtifactsPaneContent
      key={contentKey}
      target={lastTarget.current}
      browserVisible={
        state === 'open' &&
        openState.settled &&
        current.kind === 'browser'
      }
    />
  </div>
)
```

Use a single render-time edge state object rather than an effect so the browser is hidden in the same commit that begins closing. `prefersReducedMotion()` makes the initial open settled immediately when either reduced-motion signal is active.

- [x] **Step 5: Convert every variant to shell content**

Rename `ArtifactsPaneInner` to `ArtifactsPaneContent`. Remove `.ap-panel`, `data-state`, `style.flexBasis`, and width-store reads from Browser, File, Attachment, Artifact, Empty, and Diff returns. Keep correctness keys only on inner content. The browser and self-contained file branches become:

```tsx
if (target.kind === 'browser') {
  return (
    <>
      <div className="ap-row ap-row-top">
        <ApBrand />
        <div className="ap-spacer" />
        <div className="ap-actions">
          <Hint label="Close panel" side="bottom">
            <button aria-label="Close panel" onClick={closeReview}>
              <IconClose />
            </button>
          </Hint>
        </div>
      </div>
      <div className="ap-browser-body">
        <BrowserPane visible={browserVisible} />
      </div>
    </>
  )
}

if (sel.kind === 'file') {
  return <FilePanelContent path={sel.path} line={sel.line} />
}
```

Rename the existing `FilePanel`, `AttachmentPanel`, and `DiffPanel` helpers to `FilePanelContent`, `AttachmentPanelContent`, and `DiffPanelContent`, and make each return its current rows/body without a panel wrapper. Preserve the existing deep-link tick logic and all event-resolution fallbacks. A content key may remount Monaco or preview state, but it must be below `.ap-panel`.

- [x] **Step 6: Run the Artifacts Pane and presence tests**

Run:

```bash
npx vitest run src/renderer/src/components/ArtifactsPane.test.tsx src/renderer/src/lib/useAnimatedUnmount.test.ts
npm run typecheck:web
```

Expected: PASS; shell identity is stable, and only its own transform transition completes entry/exit.

- [x] **Step 7: Commit**

```bash
git add src/renderer/src/components/ArtifactsPane.tsx src/renderer/src/components/ArtifactsPane.test.tsx
git commit -m "fix: preserve artifacts pane shell across navigation"
```

---

### Task 4: Standardize pane control feedback and reduced-motion parity

**Files:**
- Modify: `src/renderer/src/components/ArtifactsPane.css`
- Create: `src/main/artifactsPaneMotionContract.test.ts`

**Interfaces:**
- Consumes: existing root motion tokens.
- Produces: shared press/color contract for all pane control families and transform-free OS/in-app reduced modes.

- [x] **Step 1: Write the failing CSS source contract**

Follow `windowChromeMotionContract.test.ts` and read `ArtifactsPane.css` as text. Assert representative families and both reduced paths:

```ts
expect(css).toContain('transform var(--dur-press-release) var(--ease-out)')
expect(css).toContain('transform var(--dur-press) var(--ease-out)')
expect(css).toContain('scale(0.97)')
expect(css).toContain(":root[data-motion='reduced']")
expect(css).toMatch(/:root\\[data-motion='reduced'\\][\\s\\S]*\\.ap-panel[\\s\\S]*transform:\\s*none/)
expect(css).toMatch(/@media \\(prefers-reduced-motion: reduce\\)[\\s\\S]*\\.ap-panel[\\s\\S]*transform:\\s*none/)
expect(css).toMatch(/:disabled[^}]*transform:\\s*none/)
```

Assert selectors include `.ap-actions button`, `.ap-segmented button`, `.ap-rail-item`, `.file-tab`, `.version-chip`, `.overview-file`, `.plan-review-actions button`, `.comment-composer-actions button`, and `.comment-bar-send, .comment-bar-close`.

- [x] **Step 2: Run the CSS contract and verify red**

Run:

```bash
npx vitest run src/main/artifactsPaneMotionContract.test.ts
```

Expected: FAIL because control families do not yet share the complete press/reduced contract and in-app panel movement is not removed.

- [x] **Step 3: Add the shared control transition**

Group existing pane pressables without changing dimensions:

```css
:is(
  .ap-actions button,
  .ap-segmented button,
  .ap-rail-item,
  .file-tab,
  .version-chip,
  .overview-file,
  .plan-review-actions button,
  .comment-composer-actions button,
  .comment-bar-send,
  .comment-bar-close
) {
  transition:
    background-color var(--dur-fast) ease,
    color var(--dur-fast) ease,
    border-color var(--dur-fast) ease,
    transform var(--dur-press-release) var(--ease-out);
}

:is(
  .ap-actions button,
  .ap-segmented button,
  .ap-rail-item,
  .file-tab,
  .version-chip,
  .overview-file,
  .plan-review-actions button,
  .comment-composer-actions button,
  .comment-bar-send,
  .comment-bar-close
):active:not(:disabled) {
  transform: scale(0.97);
  transition:
    background-color var(--dur-fast) ease,
    color var(--dur-fast) ease,
    border-color var(--dur-fast) ease,
    transform var(--dur-press) var(--ease-out);
}

:is(
  .ap-actions button,
  .ap-segmented button,
  .file-tab,
  .version-chip,
  .plan-review-actions button,
  .comment-composer-actions button,
  .comment-bar-send,
  .comment-bar-close
):disabled {
  transform: none;
}
```

- [x] **Step 4: Add exact reduced-motion parity**

Keep any opacity-only cue, but remove position:

```css
@media (prefers-reduced-motion: reduce) {
  .ap-panel,
  .ap-panel[data-state='closing'] {
    transform: none;
  }

  .ap-panel {
    @starting-style {
      transform: none;
    }
  }

  :is(
    .ap-actions button,
    .ap-segmented button,
    .ap-rail-item,
    .file-tab,
    .version-chip,
    .overview-file,
    .plan-review-actions button,
    .comment-composer-actions button,
    .comment-bar-send,
    .comment-bar-close
  ):active:not(:disabled) {
    transform: none;
  }
}

:root[data-motion='reduced'] .ap-panel,
:root[data-motion='reduced'] .ap-panel[data-state='closing'] {
  transform: none;
}

:root[data-motion='reduced'] .ap-panel {
  @starting-style {
    transform: none;
  }
}

:root[data-motion='reduced']
  :is(
    .ap-actions button,
    .ap-segmented button,
    .ap-rail-item,
    .file-tab,
    .version-chip,
    .overview-file,
    .plan-review-actions button,
    .comment-composer-actions button,
    .comment-bar-send,
    .comment-bar-close
  ):active:not(:disabled) {
  transform: none;
}
```

- [x] **Step 5: Run contract, renderer tests, and typecheck**

Run:

```bash
npx vitest run src/main/artifactsPaneMotionContract.test.ts src/renderer/src/components/ArtifactsPane.test.tsx
npm run typecheck:web
```

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/renderer/src/components/ArtifactsPane.css src/main/artifactsPaneMotionContract.test.ts
git commit -m "style: unify artifacts pane interaction motion"
```

---

### Task 5: Animate the Monaco comment zone from shared CSS tokens

**Files:**
- Create: `src/renderer/src/lib/motionTokens.ts`
- Create: `src/renderer/src/lib/motionTokens.test.ts`
- Create: `src/renderer/src/lib/heightAnimator.ts`
- Create: `src/renderer/src/lib/heightAnimator.test.ts`
- Modify: `src/renderer/src/components/monacoCommon.ts`
- Create: `src/renderer/src/components/monacoCommon.test.ts`
- Modify: `src/renderer/src/components/ArtifactsPane.css`

**Interfaces:**
- Produces:

```ts
export type CubicBezier = readonly [number, number, number, number]
export function readCssTimeMs(name: `--${string}`, root?: Element): number | null
export function readCssCubicBezier(name: `--${string}`, root?: Element): CubicBezier | null
export function evaluateCubicBezier(curve: CubicBezier, progress: number): number

export interface HeightAnimator {
  retarget(height: number, onComplete?: () => void): void
  cancel(): void
  current(): number
}

export function createHeightAnimator(options: {
  initialHeight: number
  durationMs: number | null
  curve: CubicBezier | null
  reduced: boolean
  apply: (height: number) => void
  now?: () => number
  requestFrame?: (callback: FrameRequestCallback) => number
  cancelFrame?: (id: number) => void
}): HeightAnimator
```

- Invalid/missing tokens cause a snap, not a new fallback duration.

- [x] **Step 1: Write strict token-parser tests**

```ts
document.documentElement.style.setProperty('--test-ms', '180ms')
document.documentElement.style.setProperty('--test-s', '0.18s')
document.documentElement.style.setProperty('--test-curve', 'cubic-bezier(0.23, 1, 0.32, 1)')
expect(readCssTimeMs('--test-ms')).toBe(180)
expect(readCssTimeMs('--test-s')).toBe(180)
expect(readCssTimeMs('--missing')).toBeNull()
expect(readCssTimeMs('--test-bad')).toBeNull()
expect(readCssCubicBezier('--test-curve')).toEqual([0.23, 1, 0.32, 1])
expect(evaluateCubicBezier([0.23, 1, 0.32, 1], 0)).toBe(0)
expect(evaluateCubicBezier([0.23, 1, 0.32, 1], 1)).toBe(1)
```

Add invalid unit, negative time, malformed curve, and clamped-progress cases.

- [x] **Step 2: Run parser tests and verify red**

Run:

```bash
npx vitest run src/renderer/src/lib/motionTokens.test.ts
```

Expected: FAIL because the module does not exist.

- [x] **Step 3: Implement strict token readers and easing evaluation**

Use `getComputedStyle(root).getPropertyValue(name).trim()`, anchored `ms|s` and `cubic-bezier(...)` regular expressions, finite-number checks, and Newton-Raphson with bisection fallback to solve x for y. Return exact endpoints for progress 0 and 1.

- [x] **Step 4: Run parser tests**

Run:

```bash
npx vitest run src/renderer/src/lib/motionTokens.test.ts
```

Expected: PASS.

- [x] **Step 5: Write deterministic animator tests**

Inject a manual frame queue and clock. Cover:

```ts
animator.retarget(56)
clock.advance(90)
frames.flush()
const interrupted = animator.current()
expect(interrupted).toBeGreaterThan(0)
expect(interrupted).toBeLessThan(56)

animator.retarget(0, completed)
expect(animator.current()).toBe(interrupted)
clock.advance(180)
frames.flushAll()
expect(apply).toHaveBeenLastCalledWith(0)
expect(completed).toHaveBeenCalledTimes(1)
```

Also assert reduced mode, null duration, or null curve snaps synchronously; input-growth retarget starts from current height; and `cancel()` prevents later frames and completion.

- [x] **Step 6: Run animator tests and verify red**

Run:

```bash
npx vitest run src/renderer/src/lib/heightAnimator.test.ts
```

Expected: FAIL because the animator does not exist.

- [x] **Step 7: Implement the interruptible scalar animator**

Clamp targets to `>= 0`, cancel the active frame before retargeting, preserve current interpolated height, and call completion only for the latest run. On every frame:

```ts
const progress = Math.min(1, Math.max(0, (now() - startedAt) / durationMs))
currentHeight = from + (target - from) * evaluateCubicBezier(curve, progress)
apply(currentHeight)
if (progress < 1) frameId = requestFrame(tick)
else latestCompletion?.()
```

- [x] **Step 8: Write the Monaco adapter tests**

Mock the minimal editor surface: `changeViewZones`, `layoutZone`, `removeZone`, container append/remove, decorations, mouse event registration, and disposal. Trigger a gutter click, flush the focus timer, and assert:

- zone starts at height `0`;
- animation applies increasing heights and calls `layoutZone`;
- close retargets to `0` and removes the zone only after completion;
- reopening during close does not remove the new zone;
- input growth retargets to `bar.offsetHeight + 12`;
- disposal cancels frames and removes overlay, FAB, decorations, and zone.

Set `--dur-menu` and `--ease-out` on the document root for animated cases; set `data-motion="reduced"` for the snap case.

- [x] **Step 9: Run the Monaco test and verify red**

Run:

```bash
npx vitest run src/renderer/src/components/monacoCommon.test.ts
```

Expected: FAIL because comment-zone open/close still inserts and removes a fixed 56px zone synchronously.

- [x] **Step 10: Wire tokens and animator into `attachCommenting`**

Create one animator per active zone:

```ts
const animator = createHeightAnimator({
  initialHeight: 0,
  durationMs: readCssTimeMs('--dur-menu'),
  curve: readCssCubicBezier('--ease-out'),
  reduced: prefersReducedMotion(),
  apply(height) {
    if (!zoneId || !zone) return
    zone.heightInPx = height
    ed.changeViewZones((accessor) => accessor.layoutZone(zoneId as string))
    positionOverlay()
  }
})
```

Open with `heightInPx: 0`, then retarget to `bar.offsetHeight + 12`. Close clears active decoration immediately, retargets to zero, and only its completion removes the overlay and zone. Track a generation number so a stale close completion cannot remove a reopened composer. Disposal calls `animator.cancel()` before immediate structural cleanup.

- [x] **Step 11: Add the comment-bar surface transition**

```css
.comment-bar {
  opacity: 1;
  transform: translateY(0);
  transition:
    opacity var(--dur-menu) var(--ease-out),
    transform var(--dur-menu) var(--ease-out);

  @starting-style {
    opacity: 0;
    transform: translateY(-4px);
  }
}
```

Remove the transform and transition in both OS and in-app reduced-motion blocks while leaving the final bar visible.

- [x] **Step 12: Run all Monaco motion tests and typecheck**

Run:

```bash
npx vitest run src/renderer/src/lib/motionTokens.test.ts src/renderer/src/lib/heightAnimator.test.ts src/renderer/src/components/monacoCommon.test.ts
npm run typecheck:web
```

Expected: PASS.

- [x] **Step 13: Commit**

```bash
git add src/renderer/src/lib/motionTokens.ts src/renderer/src/lib/motionTokens.test.ts src/renderer/src/lib/heightAnimator.ts src/renderer/src/lib/heightAnimator.test.ts src/renderer/src/components/monacoCommon.ts src/renderer/src/components/monacoCommon.test.ts src/renderer/src/components/ArtifactsPane.css
git commit -m "feat: animate inline comment view zones"
```

---

### Task 6: Acknowledge successful plan resolution without delaying it

**Files:**
- Modify: `src/renderer/src/components/ArtifactViewer.tsx`
- Create: `src/renderer/src/components/ArtifactViewer.test.tsx`
- Modify: `src/renderer/src/components/ArtifactsPane.css`

**Interfaces:**
- Produces: local notice type `'Approved' | 'Feedback sent' | null`; 1200ms readable lifetime; `role="status"` with `aria-live="polite"`.
- Resolution buttons are disabled together while the promise is pending.
- Failure retains feedback and actions and produces no notice.

- [x] **Step 1: Write failing review-state tests**

Seed a pending plan artifact and paired `submit_plan` tool call. Stub `resolvePlanReview` with a controlled promise. Test:

```tsx
fireEvent.click(screen.getByRole('button', { name: 'Proceed' }))
expect(screen.getByRole('button', { name: 'Proceed' })).toBeDisabled()
expect(screen.getByRole('button', { name: 'Review' })).toBeDisabled()
fireEvent.click(screen.getByRole('button', { name: 'Proceed' }))
expect(resolvePlanReview).toHaveBeenCalledTimes(1)

resolveRequest?.(true)
expect(await screen.findByRole('status')).toHaveTextContent('Approved')
expect(resolvePlanReview).toHaveBeenCalledWith('call-1', true)
```

Add feedback success expecting `Feedback sent`, failure expecting no status and preserved textarea value, fake-timer expiry at 1200ms, rerender to a different artifact clearing the notice, and unmount before expiry producing no state-update warning.

- [x] **Step 2: Run ArtifactViewer tests and verify red**

Run:

```bash
npx vitest run src/renderer/src/components/ArtifactViewer.test.tsx
```

Expected: FAIL because the action slot disappears without acknowledgment and requests can be duplicated before event refresh.

- [x] **Step 3: Implement guarded asynchronous resolution**

Add:

```ts
const [resolving, setResolving] = useState(false)
const [resolutionNotice, setResolutionNotice] =
  useState<'Approved' | 'Feedback sent' | null>(null)

const resolve = async (
  approved: boolean,
  feedback: string | undefined,
  notice: 'Approved' | 'Feedback sent'
): Promise<void> => {
  if (!pendingCall || resolving) return
  setResolving(true)
  const ok = await resolvePlanReview(pendingCall.id, approved, feedback)
  setResolving(false)
  if (!ok) return
  clearDraft()
  if (!approved) setFeedbackText('')
  setResolutionNotice(notice)
  void loadArtifactComments(selected.artifactId)
}
```

Catch rejected promises as failure so buttons re-enable and editable state remains. Clear the notice synchronously in the existing artifact-ID render adjustment. Use an effect to clear the notice after 1200ms with timer cleanup.

Render the action slot as:

```tsx
{resolutionNotice ? (
  <div className="plan-resolution-notice" role="status" aria-live="polite">
    {resolutionNotice}
  </div>
) : pendingCall ? (
  <div className="plan-review-actions">{/* both buttons disabled when resolving */}</div>
) : null}
```

- [x] **Step 4: Add restrained acknowledgment motion**

```css
.plan-resolution-notice {
  opacity: 1;
  transform: translateY(0);
  transition:
    opacity var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);

  @starting-style {
    opacity: 0;
    transform: translateY(2px);
  }
}
```

OS and in-app reduced-motion blocks set `transform: none` and remove the transform transition.

- [x] **Step 5: Run tests and typecheck**

Run:

```bash
npx vitest run src/renderer/src/components/ArtifactViewer.test.tsx src/renderer/src/components/ArtifactsPane.test.tsx
npm run typecheck:web
```

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/renderer/src/components/ArtifactViewer.tsx src/renderer/src/components/ArtifactViewer.test.tsx src/renderer/src/components/ArtifactsPane.css
git commit -m "feat: acknowledge resolved plan reviews"
```

---

### Task 7: Fade in only current resolved preview payloads

**Files:**
- Create: `src/renderer/src/components/FilePreview/PreviewEntry.tsx`
- Modify: `src/renderer/src/components/FilePreview/FilePreview.tsx`
- Modify: `src/renderer/src/components/AttachmentPreview/AttachmentPreview.tsx`
- Modify: `src/renderer/src/components/FilePreview/FilePreview.css`
- Modify: `src/renderer/src/components/FilePreview/FilePreview.test.tsx`
- Modify: `src/renderer/src/components/AttachmentPreview/AttachmentPreview.test.tsx`

**Interfaces:**
- Produces:

```tsx
export function PreviewEntry({ children }: React.PropsWithChildren): React.JSX.Element {
  return <div className="preview-entry">{children}</div>
}
```

- The wrapper mounts only where each component already knows the payload belongs to its current request.

- [x] **Step 1: Write failing wrapper and stale-payload tests**

For `FilePreview`, import `PreviewPayload`, add the same concrete deferred helper used by the attachment test, and extend the stale-request case with wrapper assertions:

```tsx
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

const first = deferred<PreviewPayload>()
const second = deferred<PreviewPayload>()
previewFile.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
const { container, rerender } = render(<FilePreview fileId="first" />)
expect(container.querySelector('.preview-entry')).toBeNull()
rerender(<FilePreview fileId="second" />)
await act(async () => first.resolve({ kind: 'text', text: 'Stale payload' }))
expect(container.querySelector('.preview-entry')).toBeNull()
await act(async () => second.resolve({ kind: 'text', text: 'Current payload' }))
expect(await screen.findByText('Current payload')).toBeInTheDocument()
expect(container.querySelectorAll('.preview-entry')).toHaveLength(1)
```

Repeat the same assertions in `AttachmentPreview.test.tsx` with its existing `deferred<PreviewPayload>()` helper: resolve the stale request first and require zero wrappers, then resolve the matching request and require exactly one.

- [x] **Step 2: Run preview tests and verify red**

Run:

```bash
npx vitest run src/renderer/src/components/FilePreview/FilePreview.test.tsx src/renderer/src/components/AttachmentPreview/AttachmentPreview.test.tsx
```

Expected: FAIL because resolved content is not wrapped by the shared entry surface.

- [x] **Step 3: Add and use `PreviewEntry`**

Wrap only the successful/current resolved branch:

```tsx
return (
  <PreviewEntry>
    <PreviewContent payload={payload} />
  </PreviewEntry>
)
```

Keep loading and error branches immediate and outside the wrapper. Do not move or weaken existing stale-request guards.

- [x] **Step 4: Add the opacity-only entry transition**

```css
.preview-entry {
  flex: 1;
  min-width: 0;
  min-height: 0;
  opacity: 1;
  transition: opacity var(--dur-fast) var(--ease-out);

  @starting-style {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .preview-entry {
    transition: none;
  }
}

:root[data-motion='reduced'] .preview-entry {
  transition: none;
}
```

- [x] **Step 5: Run preview tests and typecheck**

Run:

```bash
npx vitest run src/renderer/src/components/FilePreview/FilePreview.test.tsx src/renderer/src/components/FilePreview/PreviewContent.test.tsx src/renderer/src/components/AttachmentPreview/AttachmentPreview.test.tsx
npm run typecheck:web
```

Expected: PASS; no loading delay or overlap is introduced.

- [x] **Step 6: Commit**

```bash
git add src/renderer/src/components/FilePreview/PreviewEntry.tsx src/renderer/src/components/FilePreview/FilePreview.tsx src/renderer/src/components/AttachmentPreview/AttachmentPreview.tsx src/renderer/src/components/FilePreview/FilePreview.css src/renderer/src/components/FilePreview/FilePreview.test.tsx src/renderer/src/components/AttachmentPreview/AttachmentPreview.test.tsx
git commit -m "feat: soften resolved preview arrival"
```

---

### Task 8: Full regression verification and motion review

**Files:**
- Modify only files required to fix a concrete failure exposed by the checks below.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: passing focused tests, full suite, typechecks, lint, and production build with the approved acceptance criteria satisfied.

#### Current recertification (2026-07-28)

The completed implementation and follow-up audit were recertified from the current branch with these
exact commands:

- `npm run typecheck` — PASS with zero diagnostics in the Node and renderer projects.
- `npm test` — PASS: 340 test files passed, one skipped; 3,559 tests passed, nine skipped.
- `npm run build` — PASS for the main, preload, and renderer production builds.
- `npx vitest run src/renderer/src/components/ArtifactsPane.test.tsx src/renderer/src/components/ArtifactsPane.diff.test.tsx src/renderer/src/components/ArtifactViewer.test.tsx src/renderer/src/components/Browser/BrowserPane.test.tsx`
  — PASS: four files and 83 tests.
- `npx vitest run src/main/artifactsPaneMotionContract.test.ts` — PASS: one file and 15 tests.
- `npm run test:electron:browser` — PASS with all five headed markers: hidden bounds, latest bounds
  on show, navigation/read, screenshot capture, and teardown destroying the native view.

The original `src/main/browser/manager.test.ts` named below was removed by follow-up plan 012. Its
non-skipping coverage now lives in `manager.visibility.test.ts` and the headed Electron command;
the historical command remains visible rather than being rewritten as if it had always used the
current gate.

- [x] **Step 1: Run the focused motion and pane suite**

Run:

```bash
npx vitest run \
  src/renderer/src/lib/useAnimatedUnmount.test.ts \
  src/main/browser/manager.visibility.test.ts \
  src/main/browser/manager.test.ts \
  src/renderer/src/components/Browser/BrowserPane.test.tsx \
  src/renderer/src/components/ArtifactsPane.test.tsx \
  src/main/artifactsPaneMotionContract.test.ts \
  src/renderer/src/lib/motionTokens.test.ts \
  src/renderer/src/lib/heightAnimator.test.ts \
  src/renderer/src/components/monacoCommon.test.ts \
  src/renderer/src/components/ArtifactViewer.test.tsx \
  src/renderer/src/components/FilePreview/FilePreview.test.tsx \
  src/renderer/src/components/FilePreview/PreviewContent.test.tsx \
  src/renderer/src/components/AttachmentPreview/AttachmentPreview.test.tsx
```

Expected: all focused files PASS.

- [x] **Step 2: Run the complete test suite**

Run:

```bash
npm test
```

Expected: Vitest exits 0 with no failed test files.

- [x] **Step 3: Run static verification**

Run:

```bash
npm run typecheck
npm run lint
```

Expected: both commands exit 0.

The original motion implementation ran the static gate above. The current recertification re-ran
the zero-diagnostic `npm run typecheck`; repository convention now requires ESLint to be scoped to
changed source paths, and this documentation reconciliation changes no source behavior.

- [x] **Step 4: Run the production build**

Run:

```bash
npm run build
```

Expected: Electron Vite completes the main, preload, and renderer production builds.

- [x] **Step 5: Review the final source contracts**

Run:

```bash
rg -n "AUX_EXIT_MS|durationMs: 340|transition: all|scale\\(0\\)|ease-in" \
  src/renderer/src/components/ArtifactsPane.tsx \
  src/renderer/src/components/ArtifactsPane.css \
  src/renderer/src/components/ArtifactViewer.tsx \
  src/renderer/src/components/monacoCommon.ts
```

Expected: no duplicated drawer duration, `transition: all`, `scale(0)`, or `ease-in`; any `AUX_EXIT_MS` result is absent.

- [x] **Step 6: Inspect the complete diff and working tree**

Run:

```bash
git diff --check
git status --short
git log --oneline --decorate -10
```

Expected: no whitespace errors; only intentional implementation changes remain.

- [x] **Step 7: Commit any verification-only correction**

If Steps 1-6 required a concrete shell correction, stage only these shell files and commit:

```bash
git add src/renderer/src/components/ArtifactsPane.tsx src/renderer/src/components/ArtifactsPane.test.tsx
git commit -m "fix: close artifacts pane motion regressions"
```

If a different focused task needed correction, use that task's exact `git add` paths from its commit step instead. If no correction was required, do not create an empty commit.

No verification-only correction was required, so no empty correction commit was created.
