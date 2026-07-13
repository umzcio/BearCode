# Signed macOS Builds + In-App "Install Updates" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sign and notarize BearCode's macOS DMG build with the existing Developer ID Application
certificate, and add an in-app update flow (auto-check, banner, manual Settings check) backed by
`electron-updater` reading from GitHub Releases.

**Architecture:** `electron-builder.yml` gains real signing/notarization/publish config. A new
`src/main/updater.ts` module wraps `electron-updater`'s `autoUpdater` singleton and pushes status
over IPC to a Zustand store slice; the renderer surfaces that status via a banner (styled exactly
like the existing `TrustBanner`) and a new "Software Update" section in Settings → General.

**Tech Stack:** Electron 39, electron-builder 26, electron-updater 6.8, React 19, TypeScript
strict, Zustand, Vitest + Testing Library.

## Global Constraints

- Gate before every commit: `npx tsc --noEmit -p tsconfig.node.json` AND
  `npx tsc --noEmit -p tsconfig.web.json` AND `npx vitest run`. Baseline pre-existing errors are
  17 (node) / 2 (web) — not regressions; do not exceed that count.
- Auto-fix lint only with `npx eslint --fix <specific paths>` — never `npm run lint -- --fix`
  (that script is `eslint .` and reformats the whole repo).
- Every dropdown/menu/popover/empty-state/loading-state/error-state/tooltip must reuse the shared
  primitives in `src/renderer/src/components/ui/` and `components/Hint.tsx` — never hand-rolled.
  Specifically: use `Loading` and `ErrorCard` for the update-status display (Task 7).
- Reuse the exact `.trust-banner` / `.pill-btn` / `.pill-btn.primary` CSS classes for the new
  update banner (Task 6) — do not invent new banner classes.
- `<major>.<build>.<patch>` versioning: this release bumps `package.json` version from `0.1.0` to
  `1.0.0` (Task 8).
- No GitHub Actions / CI workflow work in this plan — publishing is local-only
  (`npm run build:mac:publish`).
- `planning/` stays gitignored and is never committed; this plan and its spec live in
  `docs/superpowers/` instead, which IS committed.

---

### Task 1: Shared `UpdaterStatus` types + `BearcodeApi` surface

**Files:**
- Modify: `src/shared/types.ts:1062` (insert after the closing brace of `PingResult`, before
  `export interface BearcodeApi {`)
- Modify: `src/shared/types.ts:1409-1412` (inside `BearcodeApi`, after the `hooks: {...}` block
  and before the existing `onEvent`/`onRunStateChange`/`onConversationMeta` lines)

**Interfaces:**
- Produces: `UpdaterState` (union type), `UpdaterStatus` (interface), and three new
  `BearcodeApi` members — `app.getVersion()`, `updater.checkNow()`, `updater.installNow()`,
  `onUpdaterStatus(cb)` — that every later task (2 through 7) consumes.

This is a type-only task (no runtime behavior), so there is no failing-test step — verification is
that the project still typechecks after the addition.

- [ ] **Step 1: Add the `UpdaterState`/`UpdaterStatus` types**

Insert immediately after line 1062 (the closing `}` of `PingResult`) in
`src/shared/types.ts`:

```ts
// ---- Auto-update (signed macOS builds arc) ----

export type UpdaterState =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'ready'
  | 'up-to-date'
  | 'error'
  | 'dev-build'

export interface UpdaterStatus {
  state: UpdaterState
  // Present on 'downloading' and 'ready' — the version being installed.
  version?: string
  // Present on 'error' — a human-readable message.
  message?: string
  // Present on 'up-to-date' — when the last successful check completed.
  checkedAt?: number
}
```

- [ ] **Step 2: Add the `app` and `updater` members + `onUpdaterStatus` to `BearcodeApi`**

In `src/shared/types.ts`, inside the `BearcodeApi` interface, right after the `hooks: { ... }`
block (the one ending `delete(name: string): Promise<void>\n  }` just before the existing
`onEvent(...)` line), insert:

```ts
  // App-level info surfaced in Settings (current version for the "Software
  // Update" section).
  app: {
    getVersion(): Promise<string>
  }
  // Signed macOS builds arc: electron-updater wrapper. checkNow() triggers a
  // check (or returns the in-flight/dev-build status immediately if one is
  // already running or the app isn't packaged); installNow() quits and
  // installs an already-downloaded update.
  updater: {
    checkNow(): Promise<UpdaterStatus>
    installNow(): Promise<void>
  }
```

And change the existing:

```ts
  onEvent(cb: (conversationId: string, event: Event) => void): () => void
  onRunStateChange(cb: (conversationId: string, state: RunState) => void): () => void
  onConversationMeta(cb: (meta: ConversationMeta) => void): () => void
}
```

to:

```ts
  onEvent(cb: (conversationId: string, event: Event) => void): () => void
  onRunStateChange(cb: (conversationId: string, state: RunState) => void): () => void
  onConversationMeta(cb: (meta: ConversationMeta) => void): () => void
  onUpdaterStatus(cb: (status: UpdaterStatus) => void): () => void
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: the same baseline error counts as before this change (17 node / 2 web) — no new errors.
(`BearcodeApi` is currently only implemented by `src/preload/index.ts`, which Task 4 updates; if
you see a "missing app/updater/onUpdaterStatus" error from `src/preload/index.ts` right now, that
is expected until Task 4 — do not fix it here.)

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(updater): add UpdaterStatus types and BearcodeApi surface"
```

---

### Task 2: `src/main/updater.ts` — electron-updater wrapper

**Files:**
- Create: `src/main/updater.ts`
- Create: `src/main/updater.test.ts`
- Modify: `package.json` (add `electron-updater` dependency)

**Interfaces:**
- Consumes: `UpdaterStatus`, `UpdaterState` from `../shared/types` (Task 1).
- Produces: `initUpdater(win: BrowserWindow): void`, `checkNow(): Promise<UpdaterStatus>`,
  `installNow(): void` — consumed by Task 3 (IPC wiring) and Task 3's caller in `index.ts`.

- [ ] **Step 1: Add the `electron-updater` dependency**

Edit `package.json`'s `dependencies` block — insert alphabetically between `docx` and `exceljs`:

```json
    "docx": "^9.7.1",
    "electron-updater": "^6.8.9",
    "exceljs": "^4.4.0",
```

Run: `npm install`
Expected: `package-lock.json` updates, `node_modules/electron-updater` exists, no errors.

- [ ] **Step 2: Write the failing test**

Create `src/main/updater.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const listeners = new Map<string, (...args: unknown[]) => void>()
const autoUpdater = {
  autoDownload: false,
  autoInstallOnAppQuit: false,
  on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
    listeners.set(event, cb)
  }),
  checkForUpdates: vi.fn(() => Promise.resolve()),
  quitAndInstall: vi.fn()
}

vi.mock('electron-updater', () => ({ autoUpdater }))

let packaged = true
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return packaged
    }
  },
  BrowserWindow: {}
}))

function fire(event: string, ...args: unknown[]): void {
  const cb = listeners.get(event)
  if (!cb) throw new Error(`no listener registered for ${event}`)
  cb(...args)
}

function fakeWindow(): { webContents: { send: ReturnType<typeof vi.fn> }; isDestroyed(): boolean } {
  return { webContents: { send: vi.fn() }, isDestroyed: () => false }
}

beforeEach(() => {
  vi.resetModules()
  listeners.clear()
  autoUpdater.checkForUpdates.mockClear()
  autoUpdater.quitAndInstall.mockClear()
  packaged = true
})

describe('initUpdater', () => {
  it('registers all five autoUpdater listeners and sets autoDownload/autoInstallOnAppQuit', async () => {
    const { initUpdater } = await import('./updater')
    initUpdater(fakeWindow() as never)
    expect(autoUpdater.autoDownload).toBe(true)
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true)
    for (const event of [
      'checking-for-update',
      'update-available',
      'update-not-available',
      'update-downloaded',
      'error'
    ]) {
      expect(listeners.has(event)).toBe(true)
    }
  })

  it('forwards update-downloaded as a ready status with the version', async () => {
    const { initUpdater } = await import('./updater')
    const win = fakeWindow()
    initUpdater(win as never)
    fire('update-downloaded', { version: '1.2.3' })
    expect(win.webContents.send).toHaveBeenCalledWith('bearcode:updater:status', {
      state: 'ready',
      version: '1.2.3'
    })
  })

  it('forwards an error event as an error status', async () => {
    const { initUpdater } = await import('./updater')
    const win = fakeWindow()
    initUpdater(win as never)
    fire('error', new Error('network down'))
    expect(win.webContents.send).toHaveBeenCalledWith('bearcode:updater:status', {
      state: 'error',
      message: 'network down'
    })
  })

  it('is a no-op when the app is not packaged', async () => {
    packaged = false
    const { initUpdater } = await import('./updater')
    initUpdater(fakeWindow() as never)
    expect(autoUpdater.on).not.toHaveBeenCalled()
  })
})

describe('checkNow', () => {
  it('returns a dev-build status without calling autoUpdater when unpackaged', async () => {
    packaged = false
    const { checkNow } = await import('./updater')
    await expect(checkNow()).resolves.toEqual({ state: 'dev-build' })
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('calls autoUpdater.checkForUpdates and resolves up-to-date on update-not-available', async () => {
    const { initUpdater, checkNow } = await import('./updater')
    initUpdater(fakeWindow() as never)
    autoUpdater.checkForUpdates.mockImplementation(() => {
      fire('update-not-available')
      return Promise.resolve()
    })
    const status = await checkNow()
    expect(status.state).toBe('up-to-date')
    expect(typeof status.checkedAt).toBe('number')
  })

  it('returns the in-flight status instead of starting a second check', async () => {
    const { initUpdater, checkNow } = await import('./updater')
    initUpdater(fakeWindow() as never)
    let resolveCheck: () => void = () => {}
    autoUpdater.checkForUpdates.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCheck = resolve
        })
    )
    const first = checkNow()
    const second = await checkNow()
    expect(second.state).toBe('checking')
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    resolveCheck()
    await first
  })

  it('resolves an error status if checkForUpdates rejects', async () => {
    const { initUpdater, checkNow } = await import('./updater')
    initUpdater(fakeWindow() as never)
    autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('boom'))
    const status = await checkNow()
    expect(status).toEqual({ state: 'error', message: 'boom' })
  })
})

describe('installNow', () => {
  it('calls autoUpdater.quitAndInstall', async () => {
    const { initUpdater, installNow } = await import('./updater')
    initUpdater(fakeWindow() as never)
    installNow()
    expect(autoUpdater.quitAndInstall).toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/main/updater.test.ts`
Expected: FAIL — `Cannot find module './updater'` (the file doesn't exist yet).

- [ ] **Step 4: Implement `src/main/updater.ts`**

```ts
import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdaterStatus } from '../shared/types'

// Startup check waits a few seconds so it never competes with initial
// app boot/render; periodic re-checks are spaced out since this is a
// background, low-urgency signal.
const STARTUP_DELAY_MS = 5000
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

let targetWindow: BrowserWindow | null = null
let currentStatus: UpdaterStatus = { state: 'idle' }

function setStatus(status: UpdaterStatus): void {
  currentStatus = status
  if (targetWindow && !targetWindow.isDestroyed()) {
    targetWindow.webContents.send('bearcode:updater:status', status)
  }
}

// Called once from main/index.ts after the main window is created. No-ops
// in dev/unpackaged builds -- electron-updater has no signed artifact to
// compare against there, so a real check would only ever fail.
export function initUpdater(win: BrowserWindow): void {
  if (!app.isPackaged) return
  targetWindow = win

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking' }))
  autoUpdater.on('update-available', (info: { version: string }) =>
    setStatus({ state: 'downloading', version: info.version })
  )
  autoUpdater.on('update-not-available', () =>
    setStatus({ state: 'up-to-date', checkedAt: Date.now() })
  )
  autoUpdater.on('update-downloaded', (info: { version: string }) =>
    setStatus({ state: 'ready', version: info.version })
  )
  autoUpdater.on('error', (err: Error) => setStatus({ state: 'error', message: err.message }))

  setTimeout(() => void checkNow(), STARTUP_DELAY_MS)
  setInterval(() => void checkNow(), CHECK_INTERVAL_MS)
}

// Triggers a check. If one is already in flight (checking/downloading),
// returns the current status instead of racing a second
// autoUpdater.checkForUpdates() call. Resolves to the dev-build status
// immediately, without touching autoUpdater, when the app isn't packaged.
export async function checkNow(): Promise<UpdaterStatus> {
  if (!app.isPackaged) return { state: 'dev-build' }
  if (currentStatus.state === 'checking' || currentStatus.state === 'downloading') {
    return currentStatus
  }
  setStatus({ state: 'checking' })
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    setStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) })
  }
  return currentStatus
}

export function installNow(): void {
  autoUpdater.quitAndInstall()
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/main/updater.test.ts`
Expected: PASS, all 10 tests green.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/main/updater.ts src/main/updater.test.ts
git commit -m "feat(updater): add electron-updater wrapper module"
```

---

### Task 3: IPC wiring + boot call

**Files:**
- Modify: `src/main/ipc.ts` (imports near top; new handlers inside `registerIpc()`)
- Modify: `src/main/index.ts` (call `initUpdater` after window creation)
- Create: `src/main/ipc.updater.test.ts`

**Interfaces:**
- Consumes: `checkNow`, `installNow` from `./updater` (Task 2, exact names); `initUpdater` from
  `./updater` (Task 2).
- Produces: IPC channels `bearcode:app:getVersion`, `bearcode:updater:checkNow`,
  `bearcode:updater:installNow` — consumed by Task 4 (preload).

- [ ] **Step 1: Write the failing test**

Create `src/main/ipc.updater.test.ts`, mirroring the existing `ipc.effort.test.ts` mock-electron
pattern:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/bearcode-ipc-updater-test'), getVersion: vi.fn(() => '1.0.0') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
  clipboard: { writeText: vi.fn() },
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn)
    }
  }
}))

const checkNow = vi.fn(async () => ({ state: 'up-to-date' as const, checkedAt: 123 }))
const installNow = vi.fn()
vi.mock('./updater', () => ({ checkNow, installNow, initUpdater: vi.fn() }))

beforeEach(async () => {
  vi.clearAllMocks()
  handlers.clear()
  const { registerIpc } = await import('./ipc')
  registerIpc()
})

describe('updater IPC', () => {
  it('bearcode:app:getVersion returns app.getVersion()', async () => {
    const handler = handlers.get('bearcode:app:getVersion')
    expect(handler).toBeDefined()
    expect(await handler!({})).toBe('1.0.0')
  })

  it('bearcode:updater:checkNow delegates to checkNow()', async () => {
    const handler = handlers.get('bearcode:updater:checkNow')
    expect(handler).toBeDefined()
    expect(await handler!({})).toEqual({ state: 'up-to-date', checkedAt: 123 })
    expect(checkNow).toHaveBeenCalled()
  })

  it('bearcode:updater:installNow delegates to installNow()', async () => {
    const handler = handlers.get('bearcode:updater:installNow')
    expect(handler).toBeDefined()
    await handler!({})
    expect(installNow).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/ipc.updater.test.ts`
Expected: FAIL — likely a real `registerIpc()` import chain error, since `./updater` isn't
imported/used by `ipc.ts` yet so the mock has nothing to intercept meaningfully, and/or "handler
is undefined" for all three assertions (the channels don't exist yet).

> Note: `registerIpc()` imports many real modules (db, orchestrator, etc.) that are NOT mocked
> here, matching how `ipc.effort.test.ts` itself only mocks a subset — if this fails on an
> unrelated missing mock, add the minimal additional `vi.mock(...)` for that module (empty
> `vi.fn()` stubs), following the same pattern already used in `ipc.effort.test.ts`.

- [ ] **Step 3: Add the imports and handlers in `src/main/ipc.ts`**

Change the top-level electron import (currently `import { BrowserWindow, clipboard, dialog,
ipcMain, shell } from 'electron'`) to also import `app`:

```ts
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
```

Add a new import alongside the other domain-module imports (near the `./orchestrator` import
block, e.g. directly after it):

```ts
import { checkNow, installNow } from './updater'
```

Inside `registerIpc()`, add these three handlers next to the other simple one-liner handlers
(e.g. right after the `ipcMain.handle('bearcode:ping', ...)` block):

```ts
  ipcMain.handle('bearcode:app:getVersion', (): string => app.getVersion())
  ipcMain.handle('bearcode:updater:checkNow', () => checkNow())
  ipcMain.handle('bearcode:updater:installNow', () => {
    installNow()
  })
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/ipc.updater.test.ts`
Expected: PASS, all 3 tests green.

- [ ] **Step 5: Wire `initUpdater` into boot**

In `src/main/index.ts`, add the import next to the other main-module imports:

```ts
import { initUpdater } from './updater'
```

Inside `createWindow()`, inside the existing `win.on('ready-to-show', ...)` handler, add the call
after `runDevSmoke(win)`:

```ts
  win.on('ready-to-show', () => {
    win.show()
    runBootResumeOnce()
    runDevSmoke(win)
    initUpdater(win)
  })
```

- [ ] **Step 6: Full gate**

Run: `npx tsc --noEmit -p tsconfig.node.json && npx vitest run`
Expected: typecheck at baseline (17 pre-existing node errors, no new ones), all tests pass
including the two new/changed files.

- [ ] **Step 7: Commit**

```bash
git add src/main/ipc.ts src/main/index.ts src/main/ipc.updater.test.ts
git commit -m "feat(updater): wire updater IPC handlers and boot-time init"
```

---

### Task 4: Preload bridge

**Files:**
- Modify: `src/preload/index.ts` (type import list; new `app`/`updater`/`onUpdaterStatus` members
  on the `bearcode` object)
- Modify: `src/preload/index.test.ts` (add a new `describe` block)

**Interfaces:**
- Consumes: `UpdaterStatus` type from `../shared/types` (Task 1); IPC channel names
  `bearcode:app:getVersion`, `bearcode:updater:checkNow`, `bearcode:updater:installNow`,
  `bearcode:updater:status` (Task 3, exact strings).
- Produces: `window.bearcode.app.getVersion()`, `window.bearcode.updater.checkNow()`,
  `window.bearcode.updater.installNow()`, `window.bearcode.onUpdaterStatus(cb)` — consumed by
  Task 5 (store).

- [ ] **Step 1: Write the failing test**

Append to `src/preload/index.test.ts` (new top-level `describe`, after the existing one):

```ts
describe('preload updater bridge', () => {
  it('app.getVersion invokes bearcode:app:getVersion', async () => {
    await import('./index')
    const bearcode = exposed as unknown as { app: { getVersion: () => Promise<string> } }
    invoke.mockClear()
    invoke.mockResolvedValueOnce('1.0.0')
    await expect(bearcode.app.getVersion()).resolves.toBe('1.0.0')
    expect(invoke).toHaveBeenCalledWith('bearcode:app:getVersion')
  })

  it('updater.checkNow invokes bearcode:updater:checkNow', async () => {
    await import('./index')
    const bearcode = exposed as unknown as { updater: { checkNow: () => Promise<unknown> } }
    invoke.mockClear()
    await bearcode.updater.checkNow()
    expect(invoke).toHaveBeenCalledWith('bearcode:updater:checkNow')
  })

  it('updater.installNow invokes bearcode:updater:installNow', async () => {
    await import('./index')
    const bearcode = exposed as unknown as { updater: { installNow: () => Promise<void> } }
    invoke.mockClear()
    await bearcode.updater.installNow()
    expect(invoke).toHaveBeenCalledWith('bearcode:updater:installNow')
  })

  it('onUpdaterStatus subscribes to bearcode:updater:status and returns an unsubscribe fn', async () => {
    const { ipcRenderer } = await import('electron')
    await import('./index')
    const bearcode = exposed as unknown as {
      onUpdaterStatus: (cb: (status: unknown) => void) => () => void
    }
    const cb = vi.fn()
    const unsubscribe = bearcode.onUpdaterStatus(cb)
    expect(ipcRenderer.on).toHaveBeenCalledWith('bearcode:updater:status', expect.any(Function))
    unsubscribe()
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
      'bearcode:updater:status',
      expect.any(Function)
    )
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/preload/index.test.ts`
Expected: FAIL — `bearcode.app` / `bearcode.updater` / `bearcode.onUpdaterStatus` are `undefined`.

- [ ] **Step 3: Implement in `src/preload/index.ts`**

Add `UpdaterStatus` to the existing `import type { ... } from '../shared/types'` list (keep
alphabetical — insert between `TranscribeMeta` and the closing brace, i.e. after
`TranscribeMeta`):

```ts
  TranscribeMeta,
  UpdaterStatus
} from '../shared/types'
```

Add the `app` and `updater` members to the `bearcode` object — insert right before the closing
`onEvent: (cb) => { ... }` block starts (i.e. right after the existing `hooks: { ... }` block, in
the same position Task 1 used in the type):

```ts
  app: {
    getVersion: (): Promise<string> => ipcRenderer.invoke('bearcode:app:getVersion')
  },
  updater: {
    checkNow: (): Promise<UpdaterStatus> => ipcRenderer.invoke('bearcode:updater:checkNow'),
    installNow: (): Promise<void> => ipcRenderer.invoke('bearcode:updater:installNow')
  },
```

Add `onUpdaterStatus` right after the existing `onConversationMeta` block, before the closing
`}` of the `bearcode` object:

```ts
  onUpdaterStatus: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, status: UpdaterStatus): void => cb(status)
    ipcRenderer.on('bearcode:updater:status', listener)
    return () => ipcRenderer.removeListener('bearcode:updater:status', listener)
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/preload/index.test.ts`
Expected: PASS, all tests green (existing + 4 new).

- [ ] **Step 5: Full gate**

Run: `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: baseline error counts only (17 node / 2 web) — the `BearcodeApi` implementation gap
noted in Task 1 Step 3 is now resolved.

- [ ] **Step 6: Commit**

```bash
git add src/preload/index.ts src/preload/index.test.ts
git commit -m "feat(updater): expose app.getVersion + updater bridge on preload"
```

---

### Task 5: Zustand store slice

**Files:**
- Modify: `src/renderer/src/state/store.ts`
- Create: `src/renderer/src/state/store.updater.test.ts`

**Interfaces:**
- Consumes: `window.bearcode.app.getVersion`, `window.bearcode.updater.checkNow`,
  `window.bearcode.updater.installNow`, `window.bearcode.onUpdaterStatus` (Task 4);
  `UpdaterStatus` type from `@shared/types` (Task 1).
- Produces: store fields `appVersion: string | null`, `updaterStatus: UpdaterStatus`,
  `updateBannerDismissed: boolean`; actions `checkForUpdates(): Promise<void>`,
  `installUpdate(): void`, `dismissUpdateBanner(): void` — consumed by Task 6 (`UpdateBanner`) and
  Task 7 (Settings section).

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/state/store.updater.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BearcodeApi, UpdaterStatus } from '@shared/types'
import { useAppStore } from './store'

let statusListener: ((status: UpdaterStatus) => void) | null = null

const bearcodeMock = {
  app: { getVersion: vi.fn(() => Promise.resolve('1.0.0')) },
  updater: {
    checkNow: vi.fn(() => Promise.resolve({ state: 'up-to-date', checkedAt: 1 } as UpdaterStatus)),
    installNow: vi.fn()
  },
  onUpdaterStatus: vi.fn((cb: (status: UpdaterStatus) => void) => {
    statusListener = cb
    return () => {
      statusListener = null
    }
  }),
  onEvent: vi.fn(),
  onRunStateChange: vi.fn(),
  onConversationMeta: vi.fn(),
  settings: { get: vi.fn(() => Promise.resolve(null)) },
  conversations: { list: vi.fn(() => Promise.resolve([])) },
  history: { search: vi.fn(() => Promise.resolve([])) }
}

beforeEach(() => {
  vi.clearAllMocks()
  statusListener = null
  vi.stubGlobal('window', { bearcode: bearcodeMock as unknown as BearcodeApi })
  useAppStore.setState({
    appVersion: null,
    updaterStatus: { state: 'idle' },
    updateBannerDismissed: false
  } as never)
})

describe('updater store slice', () => {
  it('checkForUpdates calls window.bearcode.updater.checkNow and stores the result', async () => {
    await useAppStore.getState().checkForUpdates()
    expect(bearcodeMock.updater.checkNow).toHaveBeenCalled()
    expect(useAppStore.getState().updaterStatus).toEqual({ state: 'up-to-date', checkedAt: 1 })
  })

  it('installUpdate calls window.bearcode.updater.installNow', () => {
    useAppStore.getState().installUpdate()
    expect(bearcodeMock.updater.installNow).toHaveBeenCalled()
  })

  it('dismissUpdateBanner sets updateBannerDismissed', () => {
    useAppStore.getState().dismissUpdateBanner()
    expect(useAppStore.getState().updateBannerDismissed).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/src/state/store.updater.test.ts`
Expected: FAIL — `checkForUpdates`/`installUpdate`/`dismissUpdateBanner` are not functions on the
store yet.

- [ ] **Step 3: Add state fields to the store's type + initial state**

In `src/renderer/src/state/store.ts`, in the state-shape interface, insert after
`trustBannerDismissed: boolean` (currently line 265):

```ts
  trustBannerDismissed: boolean
  // Signed macOS builds arc: current app version + live electron-updater status.
  appVersion: string | null
  updaterStatus: UpdaterStatus
  updateBannerDismissed: boolean
```

Add `UpdaterStatus` to this file's existing `import type { ... } from '@shared/types'` (or
equivalent relative path already used at the top of the file) — insert alphabetically alongside
the other imported types already there.

In the actions-shape interface, insert after `dismissTrustBanner(): void` (currently line 401):

```ts
  dismissTrustBanner(): void
  checkForUpdates(): Promise<void>
  installUpdate(): void
  dismissUpdateBanner(): void
```

In the initial-state object literal, insert after `trustBannerDismissed: false,` (currently line
573):

```ts
    trustBannerDismissed: false,
    appVersion: null,
    updaterStatus: { state: 'idle' },
    updateBannerDismissed: false,
```

- [ ] **Step 4: Wire the `onUpdaterStatus` subscription and initial version fetch into `init()`**

In `init()`, right after the existing `window.bearcode.onConversationMeta((meta) => { ... })`
block closes (currently ending at line 626, just before `void (async () => { const settings =
...`), add:

```ts
      window.bearcode.onUpdaterStatus((status) => {
        set({ updaterStatus: status })
      })
      void window.bearcode.app.getVersion().then((appVersion) => set({ appVersion }))
```

- [ ] **Step 5: Implement the three actions**

In the actions implementation object, right after `dismissTrustBanner: () => set({
trustBannerDismissed: true }),` (currently line 1253), insert:

```ts
    dismissTrustBanner: () => set({ trustBannerDismissed: true }),
    checkForUpdates: async () => {
      const status = await window.bearcode.updater.checkNow()
      set({ updaterStatus: status })
    },
    installUpdate: () => {
      window.bearcode.updater.installNow()
    },
    dismissUpdateBanner: () => set({ updateBannerDismissed: true }),
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/renderer/src/state/store.updater.test.ts`
Expected: PASS, all 3 tests green.

- [ ] **Step 7: Full renderer test run**

Run: `npx vitest run`
Expected: all tests pass, including every pre-existing `store.test.ts` /
`store.environment.test.ts` test (the new fields/actions must not break any existing store
consumer).

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/state/store.ts src/renderer/src/state/store.updater.test.ts
git commit -m "feat(updater): add updater status store slice"
```

---

### Task 6: `UpdateBanner` component

**Files:**
- Create: `src/renderer/src/components/UpdateBanner.tsx`
- Create: `src/renderer/src/components/UpdateBanner.test.tsx`
- Modify: `src/renderer/src/App.tsx`

**Interfaces:**
- Consumes: `updaterStatus`, `updateBannerDismissed`, `installUpdate`, `dismissUpdateBanner` from
  the store (Task 5, exact names).
- Produces: `<UpdateBanner />` component, rendered in `App.tsx` alongside `<TrustBanner />` /
  `<OutsideAccessCard />`.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/components/UpdateBanner.test.tsx`, mirroring
`OutsideAccessCard.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { UpdateBanner } from './UpdateBanner'
import { useAppStore } from '../state/store'

afterEach(cleanup)
beforeEach(() => {
  useAppStore.setState({
    updaterStatus: { state: 'ready', version: '1.0.1' },
    updateBannerDismissed: false,
    installUpdate: vi.fn(),
    dismissUpdateBanner: vi.fn()
  } as never)
})

describe('UpdateBanner', () => {
  it('shows the ready message with the version', () => {
    render(<UpdateBanner />)
    expect(screen.getByText(/1\.0\.1 is ready to install/i)).toBeTruthy()
  })

  it('renders nothing when state is not ready', () => {
    useAppStore.setState({ updaterStatus: { state: 'checking' } } as never)
    const { container } = render(<UpdateBanner />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when dismissed', () => {
    useAppStore.setState({ updateBannerDismissed: true } as never)
    const { container } = render(<UpdateBanner />)
    expect(container.firstChild).toBeNull()
  })

  it('Restart & Install calls installUpdate', () => {
    const installUpdate = vi.fn()
    useAppStore.setState({ installUpdate } as never)
    render(<UpdateBanner />)
    fireEvent.click(screen.getByRole('button', { name: /restart & install/i }))
    expect(installUpdate).toHaveBeenCalled()
  })

  it('Not now calls dismissUpdateBanner', () => {
    const dismissUpdateBanner = vi.fn()
    useAppStore.setState({ dismissUpdateBanner } as never)
    render(<UpdateBanner />)
    fireEvent.click(screen.getByRole('button', { name: /not now/i }))
    expect(dismissUpdateBanner).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/src/components/UpdateBanner.test.tsx`
Expected: FAIL — `Cannot find module './UpdateBanner'`.

- [ ] **Step 3: Implement `src/renderer/src/components/UpdateBanner.tsx`**

```tsx
import { useAppStore } from '../state/store'

// Styled identically to TrustBanner/OutsideAccessCard -- reuses the shared
// .trust-banner class rather than introducing a new banner style.
export function UpdateBanner(): React.JSX.Element | null {
  const status = useAppStore((s) => s.updaterStatus)
  const dismissed = useAppStore((s) => s.updateBannerDismissed)
  const install = useAppStore((s) => s.installUpdate)
  const dismiss = useAppStore((s) => s.dismissUpdateBanner)
  if (status.state !== 'ready' || dismissed) return null
  return (
    <div className="trust-banner" role="alert">
      <span className="trust-banner-msg">
        BearCode {status.version} is ready to install.
      </span>
      <span className="trust-banner-actions">
        <button className="pill-btn" onClick={dismiss}>
          Not now
        </button>
        <button className="pill-btn primary" onClick={install}>
          Restart &amp; Install
        </button>
      </span>
    </div>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/src/components/UpdateBanner.test.tsx`
Expected: PASS, all 5 tests green.

- [ ] **Step 5: Wire into `App.tsx`**

Add the import next to the other banner imports:

```ts
import { UpdateBanner } from './components/UpdateBanner'
```

Add the element right after `<OutsideAccessCard />` (currently line 134):

```tsx
        <TrustBanner />
        <OutsideAccessCard />
        <UpdateBanner />
```

- [ ] **Step 6: Full gate**

Run: `npx tsc --noEmit -p tsconfig.web.json && npx vitest run`
Expected: baseline typecheck (2 pre-existing web errors, no new ones), all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/UpdateBanner.tsx src/renderer/src/components/UpdateBanner.test.tsx src/renderer/src/App.tsx
git commit -m "feat(updater): add UpdateBanner, wired into the app shell"
```

---

### Task 7: Settings → General "Software Update" section

**Files:**
- Modify: `src/renderer/src/components/Settings/pages/GeneralPage.tsx`
- Create: `src/renderer/src/components/Settings/pages/GeneralPage.test.tsx`

**Interfaces:**
- Consumes: `appVersion`, `updaterStatus`, `checkForUpdates`, `installUpdate` from the store
  (Task 5, exact names); `Loading` (`../../ui/Loading`), `ErrorCard` (`../../ui/ErrorCard`)
  (existing primitives, per `CLAUDE.md`).

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/components/Settings/pages/GeneralPage.test.tsx` (no test file exists
for this page yet, so this also establishes baseline coverage for the page):

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { GeneralPage } from './GeneralPage'
import { useAppStore } from '../../../state/store'

afterEach(cleanup)
beforeEach(() => {
  useAppStore.setState({
    settings: { dataPath: '/tmp/data', profileName: '', profileCallMe: '', customInstructions: '' },
    saveSettings: vi.fn(async () => {}),
    deleteAllConversations: vi.fn(async () => {}),
    appVersion: '1.0.0',
    updaterStatus: { state: 'up-to-date', checkedAt: Date.now() },
    checkForUpdates: vi.fn(async () => {}),
    installUpdate: vi.fn()
  } as never)
})

describe('GeneralPage software update section', () => {
  it('shows the current app version', () => {
    render(<GeneralPage />)
    expect(screen.getByText(/1\.0\.0/)).toBeTruthy()
  })

  it('shows an up-to-date status message', () => {
    render(<GeneralPage />)
    expect(screen.getByText(/up to date/i)).toBeTruthy()
  })

  it('Check for Updates calls checkForUpdates', () => {
    const checkForUpdates = vi.fn(async () => {})
    useAppStore.setState({ checkForUpdates } as never)
    render(<GeneralPage />)
    fireEvent.click(screen.getByRole('button', { name: /check for updates/i }))
    expect(checkForUpdates).toHaveBeenCalled()
  })

  it('shows a Loading state while checking', () => {
    useAppStore.setState({ updaterStatus: { state: 'checking' } } as never)
    render(<GeneralPage />)
    expect(screen.getByText(/checking/i)).toBeTruthy()
  })

  it('shows an ErrorCard on error', () => {
    useAppStore.setState({ updaterStatus: { state: 'error', message: 'network down' } } as never)
    render(<GeneralPage />)
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText('network down')).toBeTruthy()
  })

  it('shows a Restart & Install action when ready', () => {
    const installUpdate = vi.fn()
    useAppStore.setState({
      updaterStatus: { state: 'ready', version: '1.0.1' },
      installUpdate
    } as never)
    render(<GeneralPage />)
    fireEvent.click(screen.getByRole('button', { name: /restart & install/i }))
    expect(installUpdate).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/src/components/Settings/pages/GeneralPage.test.tsx`
Expected: FAIL — the "Software Update" text/controls don't exist yet.

- [ ] **Step 3: Implement the section in `GeneralPage.tsx`**

Add the imports at the top of the file (alongside the existing `useAppStore` import):

```ts
import { Loading } from '../../ui/Loading'
import { ErrorCard } from '../../ui/ErrorCard'
```

Inside the component, add these selectors next to the existing ones:

```ts
  const appVersion = useAppStore((s) => s.appVersion)
  const updaterStatus = useAppStore((s) => s.updaterStatus)
  const checkForUpdates = useAppStore((s) => s.checkForUpdates)
  const installUpdate = useAppStore((s) => s.installUpdate)
```

Add a `statusLabel` helper right before the `return`:

```ts
  const statusLabel = (): string => {
    switch (updaterStatus.state) {
      case 'up-to-date':
        return updaterStatus.checkedAt
          ? `Up to date (checked ${new Date(updaterStatus.checkedAt).toLocaleTimeString()})`
          : 'Up to date'
      case 'dev-build':
        return 'Auto-update is unavailable in development builds'
      case 'downloading':
        return `Downloading BearCode ${updaterStatus.version ?? ''}…`
      case 'ready':
        return `Version ${updaterStatus.version ?? ''} downloaded`
      default:
        return ''
    }
  }
```

Insert a new "Software Update" section into the JSX, right after the closing `</div>` of the
"Data" `set-card` block (i.e. as the last section in the returned fragment, before the final
`</>`):

```tsx
      <div className="set-group-title">Software Update</div>
      <div className="set-card">
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-title">BearCode {appVersion ?? ''}</div>
            <div className="set-row-desc">
              {updaterStatus.state === 'checking' || updaterStatus.state === 'downloading' ? (
                <Loading label={statusLabel() || 'Checking…'} />
              ) : updaterStatus.state === 'error' ? (
                <ErrorCard>{updaterStatus.message}</ErrorCard>
              ) : (
                statusLabel()
              )}
            </div>
          </div>
          {updaterStatus.state === 'ready' ? (
            <button className="pill-btn primary" onClick={installUpdate}>
              Restart &amp; Install
            </button>
          ) : (
            <button
              className="pill-btn"
              onClick={() => void checkForUpdates()}
              disabled={updaterStatus.state === 'checking' || updaterStatus.state === 'downloading'}
            >
              Check for Updates
            </button>
          )}
        </div>
      </div>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/src/components/Settings/pages/GeneralPage.test.tsx`
Expected: PASS, all 6 tests green.

- [ ] **Step 5: Full gate**

Run: `npx tsc --noEmit -p tsconfig.web.json && npx vitest run`
Expected: baseline typecheck, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/Settings/pages/GeneralPage.tsx src/renderer/src/components/Settings/pages/GeneralPage.test.tsx
git commit -m "feat(updater): add Software Update section to Settings > General"
```

---

### Task 8: Signing, notarization, publish config, and version bump

**Files:**
- Modify: `electron-builder.yml`
- Modify: `package.json` (version bump, new script)
- Modify: `.gitignore`
- Create: `scripts/.notary-config.example`

This task is build-config-only — there is no unit test to write. Verification is a YAML parse
check plus a manual eyeball diff, both captured as explicit steps below.

- [ ] **Step 1: Update `electron-builder.yml`**

Replace the current `mac:` and `dmg:` blocks:

```yaml
mac:
  entitlementsInherit: build/entitlements.mac.plist
  extendInfo:
    - NSCameraUsageDescription: Application requests access to the device's camera.
    - NSMicrophoneUsageDescription: Application requests access to the device's microphone.
    - NSDocumentsFolderUsageDescription: Application requests access to the user's Documents folder.
    - NSDownloadsFolderUsageDescription: Application requests access to the user's Downloads folder.
  notarize: false
dmg:
  artifactName: ${name}-${version}.${ext}
```

with:

```yaml
mac:
  entitlementsInherit: build/entitlements.mac.plist
  extendInfo:
    - NSCameraUsageDescription: Application requests access to the device's camera.
    - NSMicrophoneUsageDescription: Application requests access to the device's microphone.
    - NSDocumentsFolderUsageDescription: Application requests access to the user's Documents folder.
    - NSDownloadsFolderUsageDescription: Application requests access to the user's Downloads folder.
  hardenedRuntime: true
  identity: "Developer ID Application: The University of Montana (5JJ6G6A84S)"
  notarize:
    teamId: 5JJ6G6A84S
  target:
    - dmg
    - zip
dmg:
  artifactName: ${name}-${version}.${ext}
```

Add a top-level `publish:` block — insert it after the `npmRebuild: false` line at the end of the
file:

```yaml
npmRebuild: false
publish:
  provider: github
  owner: umzcio
  repo: BearCode
```

- [ ] **Step 2: Verify the YAML parses**

Run:
```bash
node -e "const yaml = require('js-yaml'); const fs = require('fs'); const doc = yaml.load(fs.readFileSync('electron-builder.yml', 'utf8')); console.log(JSON.stringify(doc.mac, null, 2)); console.log(JSON.stringify(doc.publish, null, 2))"
```
Expected: prints the `mac` object showing `hardenedRuntime: true`, the `identity` string, `notarize.teamId: "5JJ6G6A84S"`, and `target: ["dmg", "zip"]`, followed by the `publish` object
showing `provider: "github", owner: "umzcio", repo: "BearCode"`. No parse errors.

- [ ] **Step 3: Bump the version and add the publish script**

In `package.json`, change:

```json
  "version": "0.1.0",
```

to:

```json
  "version": "1.0.0",
```

Add a new script — insert right after `"build:mac": "electron-vite build && electron-builder --mac",`:

```json
    "build:mac": "electron-vite build && electron-builder --mac",
    "build:mac:publish": "electron-vite build && electron-builder --mac --publish always",
```

- [ ] **Step 4: Add the gitignored notary credential file + example**

Add to `.gitignore`, in the "Local env & secrets" section (after `.env.*`):

```
.env.*
scripts/.notary-config.local
```

Create `scripts/.notary-config.example`:

```bash
# Copy to scripts/.notary-config.local (gitignored) and fill in your values,
# then `source scripts/.notary-config.local` before running
# `npm run build:mac:publish` (or export the three vars any other way).
#
# electron-builder's built-in notarize step (@electron/notarize) reads these
# env var names directly -- no separate notarize script needed here.

# Path to your App Store Connect API .p8 key file
export APPLE_API_KEY="$HOME/Downloads/AuthKey_XXXXXXXXXX.p8"

# Key ID -- App Store Connect -> Users and Access -> Integrations -> API Keys
export APPLE_API_KEY_ID="XXXXXXXXXX"

# Issuer UUID -- top of the API Keys page
export APPLE_API_ISSUER="00000000-0000-0000-0000-000000000000"

# GitHub personal access token with `repo` scope, for `--publish always` to
# upload the release assets.
export GH_TOKEN="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

- [ ] **Step 5: Confirm `.gitignore` actually excludes the local file**

Run: `touch scripts/.notary-config.local && git status --short scripts/`
Expected: only `scripts/.notary-config.example` shows as untracked (`??`); `.notary-config.local`
does not appear at all. Then: `rm scripts/.notary-config.local` (clean up the touch-created
placeholder; it holds no real credentials).

- [ ] **Step 6: Commit**

```bash
git add electron-builder.yml package.json .gitignore scripts/.notary-config.example
git commit -m "feat(updater): sign/notarize/publish config, bump to 1.0.0"
```

---

### Task 9: Manual live-smoke — signed build, notarization, and the real update flow

**This task has no automated steps.** It is the design's required manual verification that
signing, notarization, and the end-to-end update cycle actually work — none of Tasks 1-8's tests
can exercise a real Apple notarization round-trip or a real Squirrel.Mac install.

**Prerequisites:** `scripts/.notary-config.local` filled in with real credentials (Task 8, Step 4)
and sourced into the shell; `GH_TOKEN` exported.

- [ ] **Step 1: Build and publish version 1.0.0**

```bash
source scripts/.notary-config.local
npm run build:mac:publish
```

Expected: the build succeeds, electron-builder logs a successful `notarize` step (no
`--notarize=false` skip message), and a **draft** GitHub Release appears at
`https://github.com/umzcio/BearCode/releases` tagged `v1.0.0` with the `.dmg`, `.zip`,
`latest-mac.yml`, and `.blockmap` files attached.

- [ ] **Step 2: Verify the local build artifact is signed and notarized**

```bash
codesign --verify --deep --strict --verbose=2 dist/mac/BearCode.app
spctl -a -vv dist/mac/BearCode.app
```

Expected: `codesign` reports `valid on disk` / `satisfies its Designated Requirement`; `spctl`
reports `accepted` and `source=Notarized Developer ID`.

- [ ] **Step 3: Install and launch version 1.0.0**

Open the built `.dmg`, drag `BearCode.app` to `/Applications`, launch it. Confirm it opens with
**no Gatekeeper warning** (no "cannot be opened because the developer cannot be verified" dialog).
In Settings → General, confirm the "Software Update" section shows version `1.0.0` and "Up to
date" (or "Checking…" briefly, settling to up to date) shortly after launch.

- [ ] **Step 4: Publish the draft release**

On the GitHub Releases page, edit the `v1.0.0` draft and click "Publish release" (electron-builder
publishes as a draft by default without CI; `electron-updater` only considers published, non-draft
releases when checking for updates).

- [ ] **Step 5: Bump to 1.0.1 and publish a second release**

```bash
# edit package.json: "version": "1.0.1"
source scripts/.notary-config.local
npm run build:mac:publish
```
Then publish this second draft (`v1.0.1`) on GitHub the same way as Step 4.

- [ ] **Step 6: Confirm the running 1.0.0 app finds, downloads, and installs 1.0.1**

With the installed 1.0.0 app still running, either wait for its periodic check or click "Check
for Updates" in Settings → General. Expected sequence: status moves to "Downloading…", then the
`UpdateBanner` appears at the top of the app ("BearCode 1.0.1 is ready to install."). Click
"Restart & Install". Expected: the app quits and relaunches automatically as version `1.0.1`
(confirm in Settings → General).

- [ ] **Step 7: Verify the post-update app is still correctly signed and notarized**

```bash
codesign --verify --deep --strict --verbose=2 /Applications/BearCode.app
spctl -a -vv /Applications/BearCode.app
```

Expected: same `valid on disk` / `accepted, source=Notarized Developer ID` results as Step 2 — the
Squirrel.Mac-applied update did not break the signature.

- [ ] **Step 8: Record the result**

If every expectation above holds, this arc is done — no further commit needed (Task 8 already
committed the config; this task only produces GitHub Releases, not repo changes). If anything
fails, note exactly which step and expectation failed before touching any code, per
`superpowers:systematic-debugging` (root-cause before fixing).
