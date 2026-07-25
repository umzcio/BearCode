# Embedded Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-project embedded terminal panel to BearCode: a real pty
(`node-pty`) spawned in the project folder, rendered with `@xterm/xterm`, so a
user can run `claude`, `codex`, `git`, or anything else exactly as they would in
a standalone terminal app — multiple tabs per project, shared across every
conversation in that project.

**Architecture:** Main process `TerminalManager` singleton (keyed by project
path, one entry per open pty) exposed over a new `bearcode:terminal:*` IPC
surface with a push-based data/exit event channel (mirrors the existing
`bearcode:event` broadcast pattern). Renderer gets a new top-level `View` kind
(`{kind:'terminal', path}`, alongside `home`/`conversation`/`history`) rendering
a tab strip of `TerminalPane` components, each owning one `@xterm/xterm`
instance wired directly to the IPC bridge — no chunked pty output ever touches
Zustand state, to avoid re-rendering the app on every keystroke of output.

**Tech Stack:** `node-pty` (new native dependency), `@xterm/xterm` +
`@xterm/addon-fit` (new dependencies), existing Electron IPC/preload/Zustand
stack.

## Global Constraints

- Terminals are scoped per **project path**, not per conversation — shared
  across every conversation open on that folder (spec: `docs/superpowers/specs/2026-07-25-embedded-terminal-design.md`).
- Default shell is unsandboxed (no Seatbelt wrapping) — this is intentional,
  not a gap to fix. Do not add sandboxing in this plan.
- No session persistence or reattachment across an app restart. Every pty is
  killed on app quit (`before-quit`).
- No worktree-aware cwd resolution for v1 — a terminal tab's `cwd` is always
  the project's root path, never a specific worktree's directory.
- `node-pty` is a native Node addon. Every task that adds/uses it in a test
  must mock the `node-pty` module entirely (never spawn a real child process
  in a unit test) — this mirrors the existing `better-sqlite3` mock precedent
  (`src/main/db` tests) and the `WebContentsView`/Playwright mocks in
  `src/main/browser/manager.test.ts`.
- All open tabs for a project stay mounted simultaneously while that
  project's Terminal view is open (stacked via `opacity`/`z-index`/
  `pointer-events`, never conditionally unmounted on tab switch) so
  switching tabs never loses scrollback. Navigating away from the Terminal
  view entirely (to Chat/History/another project) DOES unmount everything;
  the underlying pty processes keep running, but returning to the Terminal
  view shows a fresh, empty-scrollback `xterm.js` buffer for each tab going
  forward. This is a deliberate v1 simplification (see spec's "Out of scope"),
  not a bug to fix.
- Motion: any transition (tab switch, tab close) uses only `opacity`/
  `transform`, motion tokens from `src/renderer/src/styles/tokens.css`, and a
  `prefers-reduced-motion: reduce` fallback, per `CLAUDE.md`.

---

### Task 1: `TerminalManager` (main-process core)

**Files:**
- Modify: `package.json` (add dependencies)
- Modify: `src/shared/types.ts` (add `TerminalSessionView`)
- Create: `src/main/terminal/manager.ts`
- Test: `src/main/terminal/manager.test.ts`

**Interfaces:**
- Produces: `TerminalSessionView` (shared type — `{ id: string; projectPath: string; title: string; createdAt: number; exited: boolean }`), `terminalManager` singleton with methods `create(projectPath: string): TerminalSessionView`, `write(id: string, data: string): void`, `resize(id: string, cols: number, rows: number): void`, `close(id: string): void`, `list(projectPath: string): TerminalSessionView[]`, `killAll(): void`, `onData(listener: (id: string, chunk: string) => void): () => void`, `onExit(listener: (id: string) => void): () => void`. Task 2 (IPC layer) consumes all of these.

- [ ] **Step 1: Install dependencies**

Run: `npm install node-pty @xterm/xterm @xterm/addon-fit`

This adds all three to `package.json`'s `dependencies`. `node-pty` is a native
addon — if the install fails to build a prebuilt binary for the current
Electron/Node ABI, do NOT work around it by pinning an old version silently;
report the exact build error, since the whole feature depends on this module
loading correctly.

- [ ] **Step 2: Add `TerminalSessionView` to shared types**

In `src/shared/types.ts`, immediately before `export interface BearcodeApi {`
(the interface starts at line 1378 as of this plan being written — search for
it, the file grows), add:

```ts
// Embedded Terminal (2026-07-25 design): one real pty per tab, scoped to a
// project path (shared across every conversation open on that folder, not
// tied to any one chat thread).
export interface TerminalSessionView {
  id: string
  projectPath: string
  title: string
  createdAt: number
  exited: boolean
}
```

- [ ] **Step 3: Write `TerminalManager`**

Create `src/main/terminal/manager.ts`:

```ts
import { randomUUID } from 'crypto'
import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import type { TerminalSessionView } from '../../shared/types'

interface TerminalSession {
  id: string
  projectPath: string
  pty: IPty
  title: string
  createdAt: number
  exited: boolean
}

function defaultShell(): string {
  return process.env.SHELL && process.env.SHELL.length > 0 ? process.env.SHELL : '/bin/zsh'
}

// node-pty's spawn() env option rejects `undefined` values that
// `process.env`'s type permits; strip them rather than casting past the type.
function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) out[k] = v
  }
  return out
}

// Main-process singleton, keyed by project path (a terminal is a workspace
// resource shared across every conversation open on that folder, not a
// per-conversation resource like the Browser feature). No sandboxing, no
// persistence across app restart -- see the plan's Global Constraints.
class TerminalManager {
  private sessions = new Map<string, TerminalSession>()
  private dataListeners = new Set<(id: string, chunk: string) => void>()
  private exitListeners = new Set<(id: string) => void>()

  onData(listener: (id: string, chunk: string) => void): () => void {
    this.dataListeners.add(listener)
    return () => this.dataListeners.delete(listener)
  }
  onExit(listener: (id: string) => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  create(projectPath: string): TerminalSessionView {
    const id = randomUUID()
    const shell = defaultShell()
    const child = pty.spawn(shell, ['-l'], {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: projectPath,
      env: cleanEnv(process.env)
    })
    const session: TerminalSession = {
      id,
      projectPath,
      pty: child,
      title: shell.split('/').pop() || 'shell',
      createdAt: Date.now(),
      exited: false
    }
    child.onData((chunk) => {
      for (const listener of this.dataListeners) listener(id, chunk)
    })
    child.onExit(() => {
      session.exited = true
      for (const listener of this.exitListeners) listener(id)
    })
    this.sessions.set(id, session)
    return this.toView(session)
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id)
    if (!session || session.exited) return
    session.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) return
    const session = this.sessions.get(id)
    if (!session || session.exited) return
    try {
      session.pty.resize(cols, rows)
    } catch {
      // The pty may have exited between the `exited` check above and this
      // call -- never let a resize race crash the app.
    }
  }

  close(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    if (!session.exited) {
      try {
        session.pty.kill()
      } catch {
        // Already dead.
      }
    }
    this.sessions.delete(id)
  }

  list(projectPath: string): TerminalSessionView[] {
    return [...this.sessions.values()]
      .filter((s) => s.projectPath === projectPath)
      .map((s) => this.toView(s))
  }

  // Called once, from main/index.ts's 'before-quit' handler (Task 2) -- every
  // real shell process must die with the app, since there is no reattach.
  killAll(): void {
    for (const session of this.sessions.values()) {
      if (!session.exited) {
        try {
          session.pty.kill()
        } catch {
          // Already dead.
        }
      }
    }
    this.sessions.clear()
  }

  private toView(s: TerminalSession): TerminalSessionView {
    return {
      id: s.id,
      projectPath: s.projectPath,
      title: s.title,
      createdAt: s.createdAt,
      exited: s.exited
    }
  }
}

export const terminalManager = new TerminalManager()
```

- [ ] **Step 4: Write the test file**

Create `src/main/terminal/manager.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

interface FakePty {
  onData: (cb: (data: string) => void) => void
  onExit: (cb: () => void) => void
  write: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  emitData: (data: string) => void
  emitExit: () => void
}

function makeFakePty(): FakePty {
  let dataCb: ((data: string) => void) | null = null
  let exitCb: (() => void) | null = null
  return {
    onData: (cb) => {
      dataCb = cb
    },
    onExit: (cb) => {
      exitCb = cb
    },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    emitData: (data) => dataCb?.(data),
    emitExit: () => exitCb?.()
  }
}

const spawned: FakePty[] = []
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    const p = makeFakePty()
    spawned.push(p)
    return p
  })
}))

const pty = await import('node-pty')
const { terminalManager } = await import('./manager')

beforeEach(() => {
  spawned.length = 0
  terminalManager.killAll()
  vi.clearAllMocks()
})

describe('TerminalManager', () => {
  it('creates a session scoped to a project path', () => {
    const view = terminalManager.create('/proj/a')
    expect(view.projectPath).toBe('/proj/a')
    expect(view.exited).toBe(false)
    expect(terminalManager.list('/proj/a')).toHaveLength(1)
    expect(terminalManager.list('/proj/b')).toHaveLength(0)
  })

  it('scopes multiple sessions independently per project', () => {
    terminalManager.create('/proj/a')
    terminalManager.create('/proj/a')
    terminalManager.create('/proj/b')
    expect(terminalManager.list('/proj/a')).toHaveLength(2)
    expect(terminalManager.list('/proj/b')).toHaveLength(1)
  })

  it('spawns with cwd set to the project path', () => {
    terminalManager.create('/proj/a')
    const spawnMock = vi.mocked(pty.spawn)
    const opts = spawnMock.mock.calls.at(-1)?.[2] as { cwd?: string }
    expect(opts.cwd).toBe('/proj/a')
  })

  it('falls back to /bin/zsh when $SHELL is unset', () => {
    const prev = process.env.SHELL
    delete process.env.SHELL
    terminalManager.create('/proj/a')
    const spawnMock = vi.mocked(pty.spawn)
    expect(spawnMock.mock.calls.at(-1)?.[0]).toBe('/bin/zsh')
    if (prev !== undefined) process.env.SHELL = prev
  })

  it('writes to the underlying pty', () => {
    const view = terminalManager.create('/proj/a')
    terminalManager.write(view.id, 'ls\n')
    expect(spawned[0].write).toHaveBeenCalledWith('ls\n')
  })

  it('ignores a write to an unknown id', () => {
    expect(() => terminalManager.write('nope', 'x')).not.toThrow()
  })

  it('resizes the underlying pty', () => {
    const view = terminalManager.create('/proj/a')
    terminalManager.resize(view.id, 120, 40)
    expect(spawned[0].resize).toHaveBeenCalledWith(120, 40)
  })

  it('ignores a non-positive resize', () => {
    const view = terminalManager.create('/proj/a')
    terminalManager.resize(view.id, 0, 40)
    expect(spawned[0].resize).not.toHaveBeenCalled()
  })

  it('marks a session exited and stops accepting writes/resizes after exit', () => {
    const view = terminalManager.create('/proj/a')
    spawned[0].emitExit()
    expect(terminalManager.list('/proj/a')[0].exited).toBe(true)
    terminalManager.write(view.id, 'x')
    terminalManager.resize(view.id, 100, 30)
    expect(spawned[0].write).not.toHaveBeenCalled()
    expect(spawned[0].resize).not.toHaveBeenCalled()
  })

  it('notifies onData listeners with incremental chunks', () => {
    const view = terminalManager.create('/proj/a')
    const chunks: string[] = []
    const unsubscribe = terminalManager.onData((id, chunk) => {
      if (id === view.id) chunks.push(chunk)
    })
    spawned[0].emitData('hello ')
    spawned[0].emitData('world')
    expect(chunks.join('')).toBe('hello world')
    unsubscribe()
  })

  it('notifies onExit listeners exactly once per session', () => {
    const view = terminalManager.create('/proj/a')
    const exited: string[] = []
    const unsubscribe = terminalManager.onExit((id) => exited.push(id))
    spawned[0].emitExit()
    expect(exited).toEqual([view.id])
    unsubscribe()
  })

  it('close() kills a live pty and removes it from the list', () => {
    const view = terminalManager.create('/proj/a')
    terminalManager.close(view.id)
    expect(spawned[0].kill).toHaveBeenCalled()
    expect(terminalManager.list('/proj/a')).toHaveLength(0)
  })

  it('close() on an already-exited session does not call kill again', () => {
    const view = terminalManager.create('/proj/a')
    spawned[0].emitExit()
    terminalManager.close(view.id)
    expect(spawned[0].kill).not.toHaveBeenCalled()
  })

  it('killAll() kills every live session across all projects and clears the list', () => {
    terminalManager.create('/proj/a')
    terminalManager.create('/proj/b')
    terminalManager.killAll()
    expect(spawned[0].kill).toHaveBeenCalled()
    expect(spawned[1].kill).toHaveBeenCalled()
    expect(terminalManager.list('/proj/a')).toHaveLength(0)
    expect(terminalManager.list('/proj/b')).toHaveLength(0)
  })
})
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/main/terminal/manager.test.ts`
Expected: all tests pass.

- [ ] **Step 6: Run both tsc gates**

Run: `npx tsc --noEmit -p tsconfig.node.json` and `npx tsc --noEmit -p tsconfig.web.json`
Expected: no new errors beyond the documented baseline (17 node-tc / 2 web-tc).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/shared/types.ts src/main/terminal/manager.ts src/main/terminal/manager.test.ts
git commit -m "feat(terminal): add TerminalManager (pty lifecycle per project path)"
```

---

### Task 2: IPC bridge, preload API, and app-quit cleanup

**Files:**
- Modify: `src/shared/types.ts` (extend `BearcodeApi`)
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/index.ts`
- Test: `src/main/ipc.terminal.test.ts`

**Interfaces:**
- Consumes: `terminalManager` from Task 1 (`src/main/terminal/manager.ts`), `TerminalSessionView` from `src/shared/types.ts`.
- Produces: IPC channels `bearcode:terminal:{create,write,resize,close,list}` (invoke) and `bearcode:terminal:{data,exit}` (broadcast events); `window.bearcode.terminal.{create,write,resize,close,list}` and `window.bearcode.{onTerminalData,onTerminalExit}` on the preload bridge, consumed by Task 3 (store) and Task 4 (`TerminalPane`).

- [ ] **Step 1: Extend `BearcodeApi`**

In `src/shared/types.ts`, find the `browser: { ... }` block inside
`BearcodeApi` (currently ends with `hide(): Promise<void>` followed by a
closing `}` around line 1610). Immediately after that closing `}`, add:

```ts
  // Embedded Terminal (2026-07-25 design): a real pty per tab, scoped to a
  // project path. create/list return TerminalSessionView; onTerminalData/
  // onTerminalExit (below, alongside the other on* subscriptions) push
  // incremental output -- never buffered through this invoke surface.
  terminal: {
    create(projectPath: string): Promise<TerminalSessionView>
    write(id: string, data: string): Promise<void>
    resize(id: string, cols: number, rows: number): Promise<void>
    close(id: string): Promise<void>
    list(projectPath: string): Promise<TerminalSessionView[]>
  }
```

Then find `onUpdaterStatus(cb: (status: UpdaterStatus) => void): () => void`
(the last method before the interface's closing `}`) and add two more
methods immediately after it, still inside the interface:

```ts
  onTerminalData(cb: (id: string, chunk: string) => void): () => void
  onTerminalExit(cb: (id: string) => void): () => void
```

- [ ] **Step 2: Add the IPC handlers**

In `src/main/ipc.ts`, add the import near the other manager imports (next to
`import { browserManager } from './browser/manager'`):

```ts
import { terminalManager } from './terminal/manager'
```

Inside `registerIpc()`, immediately after the existing browser IPC block
(after the `ipcMain.handle('bearcode:browser:show', ...)` line), add:

```ts
  // Embedded Terminal (2026-07-25 design): TerminalManager is a main-side
  // singleton keyed by project path. Data/exit are pushed to every window via
  // `broadcast`, mirroring the `sink` object above -- never polled.
  ipcMain.handle('bearcode:terminal:create', (_e, projectPath: string) =>
    terminalManager.create(projectPath)
  )
  ipcMain.handle('bearcode:terminal:write', (_e, id: string, data: string) => {
    terminalManager.write(id, data)
  })
  ipcMain.handle('bearcode:terminal:resize', (_e, id: string, cols: number, rows: number) => {
    terminalManager.resize(id, cols, rows)
  })
  ipcMain.handle('bearcode:terminal:close', (_e, id: string) => {
    terminalManager.close(id)
  })
  ipcMain.handle('bearcode:terminal:list', (_e, projectPath: string) =>
    terminalManager.list(projectPath)
  )
  terminalManager.onData((id, chunk) => broadcast('bearcode:terminal:data', id, chunk))
  terminalManager.onExit((id) => broadcast('bearcode:terminal:exit', id))
```

(`broadcast` is the existing module-scoped helper defined above `const sink = {...}` in this same file — no new import needed.)

- [ ] **Step 3: Add the preload bridge**

In `src/preload/index.ts`, add the invoke methods to the `bearcode` object,
immediately after the existing `browser: { ... }` block:

```ts
  terminal: {
    create: (projectPath: string): Promise<TerminalSessionView> =>
      ipcRenderer.invoke('bearcode:terminal:create', projectPath),
    write: (id: string, data: string): Promise<void> =>
      ipcRenderer.invoke('bearcode:terminal:write', id, data),
    resize: (id: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke('bearcode:terminal:resize', id, cols, rows),
    close: (id: string): Promise<void> => ipcRenderer.invoke('bearcode:terminal:close', id),
    list: (projectPath: string): Promise<TerminalSessionView[]> =>
      ipcRenderer.invoke('bearcode:terminal:list', projectPath)
  },
```

Add `TerminalSessionView` to the existing `import type { ... } from '../shared/types'`
at the top of the file.

Then add the two push-event subscriptions immediately after the existing
`onUpdaterStatus` block (before the closing `}` of the `bearcode` object,
i.e. right before the final `contextBridge.exposeInMainWorld('bearcode', bearcode)` line):

```ts
  onTerminalData: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, id: string, chunk: string): void => cb(id, chunk)
    ipcRenderer.on('bearcode:terminal:data', listener)
    return () => ipcRenderer.removeListener('bearcode:terminal:data', listener)
  },
  onTerminalExit: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, id: string): void => cb(id)
    ipcRenderer.on('bearcode:terminal:exit', listener)
    return () => ipcRenderer.removeListener('bearcode:terminal:exit', listener)
  }
```

- [ ] **Step 4: Kill all terminal sessions on app quit**

In `src/main/index.ts`, add the import:

```ts
import { terminalManager } from './terminal/manager'
```

Add a new `before-quit` handler near the existing `app.on('window-all-closed', ...)`
block at the bottom of the file:

```ts
app.on('before-quit', () => {
  terminalManager.killAll()
})
```

- [ ] **Step 5: Write the IPC test file**

Create `src/main/ipc.terminal.test.ts`, following the same full-mock-header
pattern as `src/main/ipc.hermes.test.ts` (registerIpc() pulls in nearly the
whole main-process graph, so every direct dependency of `ipc.ts` must be
mocked or the import throws). Copy `ipc.hermes.test.ts`'s mock header
verbatim as the base (same `electron`/`keys`/`permissions`/`settings`/
`providers/registry`/`diffs`/`db`/`agentsDir`/`orchestrator/commands`/
`orchestrator/mentionSuggest`/`orchestrator` mocks), replace its
`hermes/gatewayClient` mock with a `./terminal/manager` mock, and drop the
hermes-specific `db` overrides in `beforeEach` (not needed here):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/bearcode-ipc-terminal-test') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn() },
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn)
    }
  }
}))
vi.mock('./terminal/manager', () => ({
  terminalManager: {
    create: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
    list: vi.fn(() => []),
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn())
  }
}))
vi.mock('./keys', () => ({
  keyStatus: vi.fn(),
  setKey: vi.fn(),
  setHermesToken: vi.fn(),
  getHermesToken: vi.fn()
}))
vi.mock('./hermes/gatewayClient', () => ({ checkHermesHealth: vi.fn() }))
vi.mock('./permissions', () => ({
  addUserRule: vi.fn(),
  deleteUserRule: vi.fn(),
  listRulesInfo: vi.fn(),
  setBuiltinDisabled: vi.fn()
}))
vi.mock('./settings', () => ({ setSettings: vi.fn(), settingsInfo: vi.fn() }))
vi.mock('./providers/registry', () => ({ listAllModels: vi.fn(), listManageableModels: vi.fn() }))
vi.mock('./diffs', () => ({ filePathFor: vi.fn(), getDiff: vi.fn(), revertFile: vi.fn() }))
vi.mock('./db', () => ({
  createConversation: vi.fn(),
  setModelRef: vi.fn(),
  setHermesSessionId: vi.fn(),
  getConversationMeta: vi.fn(),
  listConversations: vi.fn(() => []),
  getEvents: vi.fn(() => []),
  deleteConversation: vi.fn(),
  setPermissionMode: vi.fn(),
  setEffort: vi.fn(),
  setUrsaMode: vi.fn(),
  setThinking: vi.fn(),
  clearAll: vi.fn(),
  insertArtifactComment: vi.fn(),
  listArtifactComments: vi.fn(() => [])
}))
vi.mock('./agentsDir', () => ({ loadAgentsContent: vi.fn() }))
vi.mock('./orchestrator/commands', () => ({ listCommands: vi.fn() }))
vi.mock('./orchestrator/mentionSuggest', () => ({
  suggestFiles: vi.fn(),
  manualRuleInfos: vi.fn()
}))
vi.mock('./orchestrator', () => ({
  assertValidAttachments: vi.fn(),
  assertValidCommand: vi.fn(),
  assertValidMentions: vi.fn(),
  assertValidPlanReviewResolution: vi.fn(),
  cancelRunOrchestrator: vi.fn(),
  clearRunsOrchestrator: vi.fn(),
  forgetRunOrchestrator: vi.fn(),
  pruneCheckpoints: vi.fn(),
  resolveApprovalOrchestrator: vi.fn(),
  resolvePlanReviewOrchestrator: vi.fn(),
  resumeInterruptedRuns: vi.fn(),
  startRunOrchestrator: vi.fn()
}))

import { registerIpc } from './ipc'
import { terminalManager } from './terminal/manager'

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  registerIpc()
})

describe('bearcode:terminal:* IPC surface', () => {
  it('registers the full terminal:* channel set', () => {
    for (const channel of [
      'bearcode:terminal:create',
      'bearcode:terminal:write',
      'bearcode:terminal:resize',
      'bearcode:terminal:close',
      'bearcode:terminal:list'
    ]) {
      expect(handlers.get(channel)).toBeTypeOf('function')
    }
  })

  it('create() delegates to terminalManager.create with the project path', () => {
    const view = { id: 'x', projectPath: '/proj', title: 'zsh', createdAt: 0, exited: false }
    vi.mocked(terminalManager.create).mockReturnValue(view)
    const handler = handlers.get('bearcode:terminal:create')!
    expect(handler(null, '/proj')).toEqual(view)
    expect(terminalManager.create).toHaveBeenCalledWith('/proj')
  })

  it('write() delegates to terminalManager.write with id and data', () => {
    const handler = handlers.get('bearcode:terminal:write')!
    handler(null, 'x', 'ls\n')
    expect(terminalManager.write).toHaveBeenCalledWith('x', 'ls\n')
  })

  it('resize() delegates to terminalManager.resize with id, cols, rows', () => {
    const handler = handlers.get('bearcode:terminal:resize')!
    handler(null, 'x', 120, 40)
    expect(terminalManager.resize).toHaveBeenCalledWith('x', 120, 40)
  })

  it('close() delegates to terminalManager.close with id', () => {
    const handler = handlers.get('bearcode:terminal:close')!
    handler(null, 'x')
    expect(terminalManager.close).toHaveBeenCalledWith('x')
  })

  it('list() delegates to terminalManager.list with the project path', () => {
    vi.mocked(terminalManager.list).mockReturnValue([])
    const handler = handlers.get('bearcode:terminal:list')!
    expect(handler(null, '/proj')).toEqual([])
    expect(terminalManager.list).toHaveBeenCalledWith('/proj')
  })

  it('wires terminalManager.onData/onExit exactly once per registerIpc() call', () => {
    expect(terminalManager.onData).toHaveBeenCalledTimes(1)
    expect(terminalManager.onExit).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/main/ipc.terminal.test.ts`
Expected: all tests pass.

- [ ] **Step 7: Run both tsc gates**

Run: `npx tsc --noEmit -p tsconfig.node.json` and `npx tsc --noEmit -p tsconfig.web.json`
Expected: no new errors beyond baseline.

- [ ] **Step 8: Commit**

```bash
git add src/shared/types.ts src/main/ipc.ts src/preload/index.ts src/main/index.ts src/main/ipc.terminal.test.ts
git commit -m "feat(terminal): wire IPC bridge, preload API, and app-quit cleanup"
```

---

### Task 3: Renderer store — view kind, tab metadata, actions

**Files:**
- Modify: `src/renderer/src/state/store.ts`
- Test: `src/renderer/src/state/store.terminal.test.ts`

**Interfaces:**
- Consumes: `window.bearcode.terminal.{create,close,list}` (Task 2's preload bridge). This task does NOT consume `onTerminalData`/`onTerminalExit` — those are wired directly inside `TerminalPane` (Task 4), never through Zustand, so high-frequency pty output never triggers a store `set()`.
- Produces: `View` union gains `{ kind: 'terminal'; path: string }`. New state: `terminalTabs: Record<string, TerminalTabMeta[]>` (keyed by project path), `activeTerminalTab: Record<string, string | undefined>`. New actions: `openTerminalView(path: string): void`, `createTerminalTab(path: string): Promise<void>`, `closeTerminalTab(path: string, id: string): Promise<void>`, `setActiveTerminalTab(path: string, id: string): void`. Task 5 (`TerminalView`) and Task 6 (Sidebar button) consume these.

- [ ] **Step 1: Extend the `View` union**

In `src/renderer/src/state/store.ts`, find:

```ts
type View = { kind: 'home' } | { kind: 'conversation'; id: string } | { kind: 'history' }
```

Replace with:

```ts
type View =
  | { kind: 'home' }
  | { kind: 'conversation'; id: string }
  | { kind: 'history' }
  | { kind: 'terminal'; path: string }

export type TerminalTabMeta = {
  id: string
  title: string
  exited: boolean
}
```

- [ ] **Step 2: Add state fields**

Find the state object's field list (the same region as `auxSelection: null,`
around line 660 in the current file — search for that exact line). Add two
new fields alongside it:

```ts
    terminalTabs: {},
    activeTerminalTab: {},
```

And add the corresponding type declarations to the store's state interface
(wherever `auxSelection: AuxSelection | null` is declared in the interface
above the implementation — add immediately after it):

```ts
  terminalTabs: Record<string, TerminalTabMeta[]>
  activeTerminalTab: Record<string, string | undefined>
```

- [ ] **Step 3: Add the actions**

Add these four actions to the store (near other view-switching actions such
as `goHome`/`openHistory` — search for `openHistory: () =>` as the anchor and
add immediately after its definition):

```ts
    openTerminalView: (path: string) => {
      set({ view: { kind: 'terminal', path }, auxSelection: null })
    },

    createTerminalTab: async (path: string) => {
      const view = await window.bearcode.terminal.create(path)
      set((s) => {
        const existing = s.terminalTabs[path] ?? []
        return {
          terminalTabs: {
            ...s.terminalTabs,
            [path]: [...existing, { id: view.id, title: view.title, exited: false }]
          },
          activeTerminalTab: { ...s.activeTerminalTab, [path]: view.id }
        }
      })
    },

    closeTerminalTab: async (path: string, id: string) => {
      await window.bearcode.terminal.close(id)
      set((s) => {
        const remaining = (s.terminalTabs[path] ?? []).filter((t) => t.id !== id)
        const wasActive = s.activeTerminalTab[path] === id
        return {
          terminalTabs: { ...s.terminalTabs, [path]: remaining },
          activeTerminalTab: {
            ...s.activeTerminalTab,
            [path]: wasActive ? remaining.at(-1)?.id : s.activeTerminalTab[path]
          }
        }
      })
    },

    setActiveTerminalTab: (path: string, id: string) => {
      set((s) => ({ activeTerminalTab: { ...s.activeTerminalTab, [path]: id } }))
    },
```

- [ ] **Step 4: Mark a tab exited on remote exit**

`TerminalPane` (Task 4) subscribes to `onTerminalExit` directly and needs a
way to flag the corresponding tab's metadata as exited (for the tab strip's
"exited" affordance, Task 5). Add one more action, next to the ones above:

```ts
    markTerminalTabExited: (path: string, id: string) => {
      set((s) => ({
        terminalTabs: {
          ...s.terminalTabs,
          [path]: (s.terminalTabs[path] ?? []).map((t) => (t.id === id ? { ...t, exited: true } : t))
        }
      }))
    },
```

- [ ] **Step 5: Write the test file**

Create `src/renderer/src/state/store.terminal.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAppStore } from './store'

vi.stubGlobal('bearcode', {
  terminal: {
    create: vi.fn(),
    close: vi.fn()
  }
})

beforeEach(() => {
  useAppStore.setState({ terminalTabs: {}, activeTerminalTab: {}, view: { kind: 'home' } })
  vi.clearAllMocks()
})

describe('terminal tab store actions', () => {
  it('openTerminalView switches to the terminal view for a path and closes any aux pane', () => {
    useAppStore.setState({ auxSelection: { kind: 'artifact', artifactId: 'a' } })
    useAppStore.getState().openTerminalView('/proj/a')
    expect(useAppStore.getState().view).toEqual({ kind: 'terminal', path: '/proj/a' })
    expect(useAppStore.getState().auxSelection).toBeNull()
  })

  it('createTerminalTab appends a tab and makes it active', async () => {
    vi.mocked(window.bearcode.terminal.create).mockResolvedValue({
      id: 't1',
      projectPath: '/proj/a',
      title: 'zsh',
      createdAt: 0,
      exited: false
    })
    await useAppStore.getState().createTerminalTab('/proj/a')
    expect(useAppStore.getState().terminalTabs['/proj/a']).toEqual([
      { id: 't1', title: 'zsh', exited: false }
    ])
    expect(useAppStore.getState().activeTerminalTab['/proj/a']).toBe('t1')
  })

  it('scopes tabs independently per project path', async () => {
    vi.mocked(window.bearcode.terminal.create).mockResolvedValueOnce({
      id: 't1',
      projectPath: '/proj/a',
      title: 'zsh',
      createdAt: 0,
      exited: false
    })
    vi.mocked(window.bearcode.terminal.create).mockResolvedValueOnce({
      id: 't2',
      projectPath: '/proj/b',
      title: 'zsh',
      createdAt: 0,
      exited: false
    })
    await useAppStore.getState().createTerminalTab('/proj/a')
    await useAppStore.getState().createTerminalTab('/proj/b')
    expect(useAppStore.getState().terminalTabs['/proj/a']).toHaveLength(1)
    expect(useAppStore.getState().terminalTabs['/proj/b']).toHaveLength(1)
  })

  it('closeTerminalTab removes the tab and calls the IPC bridge', async () => {
    useAppStore.setState({
      terminalTabs: { '/proj/a': [{ id: 't1', title: 'zsh', exited: false }] },
      activeTerminalTab: { '/proj/a': 't1' }
    })
    vi.mocked(window.bearcode.terminal.close).mockResolvedValue(undefined)
    await useAppStore.getState().closeTerminalTab('/proj/a', 't1')
    expect(window.bearcode.terminal.close).toHaveBeenCalledWith('t1')
    expect(useAppStore.getState().terminalTabs['/proj/a']).toEqual([])
    expect(useAppStore.getState().activeTerminalTab['/proj/a']).toBeUndefined()
  })

  it('closeTerminalTab falls back the active tab to the last remaining tab', async () => {
    useAppStore.setState({
      terminalTabs: {
        '/proj/a': [
          { id: 't1', title: 'zsh', exited: false },
          { id: 't2', title: 'zsh', exited: false }
        ]
      },
      activeTerminalTab: { '/proj/a': 't1' }
    })
    vi.mocked(window.bearcode.terminal.close).mockResolvedValue(undefined)
    await useAppStore.getState().closeTerminalTab('/proj/a', 't1')
    expect(useAppStore.getState().activeTerminalTab['/proj/a']).toBe('t2')
  })

  it('setActiveTerminalTab switches the active tab for a path', () => {
    useAppStore.setState({
      terminalTabs: {
        '/proj/a': [
          { id: 't1', title: 'zsh', exited: false },
          { id: 't2', title: 'zsh', exited: false }
        ]
      },
      activeTerminalTab: { '/proj/a': 't1' }
    })
    useAppStore.getState().setActiveTerminalTab('/proj/a', 't2')
    expect(useAppStore.getState().activeTerminalTab['/proj/a']).toBe('t2')
  })

  it('markTerminalTabExited flags only the matching tab', () => {
    useAppStore.setState({
      terminalTabs: {
        '/proj/a': [
          { id: 't1', title: 'zsh', exited: false },
          { id: 't2', title: 'zsh', exited: false }
        ]
      }
    })
    useAppStore.getState().markTerminalTabExited('/proj/a', 't1')
    expect(useAppStore.getState().terminalTabs['/proj/a']).toEqual([
      { id: 't1', title: 'zsh', exited: true },
      { id: 't2', title: 'zsh', exited: false }
    ])
  })
})
```

If `useAppStore` in this codebase does not expose a plain `vi.stubGlobal('bearcode', ...)`-friendly `window.bearcode` (check an existing renderer store test, e.g. any `store.*.test.ts` file, for the established mocking convention) — follow that file's exact convention instead of the above, since the store test setup pattern is established codebase-wide and must stay consistent.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/renderer/src/state/store.terminal.test.ts`
Expected: all tests pass.

- [ ] **Step 7: Run both tsc gates**

Run: `npx tsc --noEmit -p tsconfig.node.json` and `npx tsc --noEmit -p tsconfig.web.json`
Expected: no new errors beyond baseline.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/state/store.ts src/renderer/src/state/store.terminal.test.ts
git commit -m "feat(terminal): add terminal view kind, tab metadata, and store actions"
```

---

### Task 4: `TerminalPane` (xterm.js component)

**Files:**
- Create: `src/renderer/src/components/Terminal/TerminalPane.tsx`
- Create: `src/renderer/src/components/Terminal/TerminalPane.css`
- Test: `src/renderer/src/components/Terminal/TerminalPane.test.tsx`

**Interfaces:**
- Consumes: `window.bearcode.terminal.{write,resize}`, `window.bearcode.onTerminalData`, `window.bearcode.onTerminalExit` (Task 2), `markTerminalTabExited` action (Task 3).
- Produces: `TerminalPane` component with props `{ id: string; path: string; active: boolean }`. Task 5 (`TerminalView`) renders one per open tab.

- [ ] **Step 1: Write `TerminalPane.tsx`**

```tsx
import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useAppStore } from '../../state/store'
import './TerminalPane.css'

function xtermTheme(): {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
} {
  const styles = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string): string => styles.getPropertyValue(name).trim() || fallback
  return {
    background: v('--bg-window', '#1b1b1b'),
    foreground: v('--text', '#e7e7e7'),
    cursor: v('--accent', '#4c8dff'),
    selectionBackground: v('--bg-active', '#2e2e2e')
  }
}

// One real xterm.js instance per tab. Mounted for the LIFETIME of the tab
// (see TerminalView -- all open tabs stay mounted, stacked via CSS, never
// conditionally unmounted on tab switch), so switching tabs never loses
// scrollback. Output never touches Zustand: onTerminalData writes straight
// into this instance's buffer, which is exactly the perf reason to use a
// real terminal library instead of storing text in app state.
export function TerminalPane({
  id,
  path,
  active
}: {
  id: string
  path: string
  active: boolean
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const markExited = useAppStore((s) => s.markTerminalTabExited)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({ theme: xtermTheme(), fontFamily: 'Menlo, monospace', fontSize: 12 })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(container)
    fitAddon.fit()
    void window.bearcode.terminal.resize(id, term.cols, term.rows)

    const disposeOnData = term.onData((data) => {
      void window.bearcode.terminal.write(id, data)
    })
    const unsubscribeData = window.bearcode.onTerminalData((dataId, chunk) => {
      if (dataId === id) term.write(chunk)
    })
    const unsubscribeExit = window.bearcode.onTerminalExit((exitId) => {
      if (exitId === id) markExited(path, id)
    })

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
      void window.bearcode.terminal.resize(id, term.cols, term.rows)
    })
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      disposeOnData.dispose()
      unsubscribeData()
      unsubscribeExit()
      term.dispose()
    }
    // Mount once per tab id -- this effect intentionally never re-runs for
    // path/markExited changes (a tab's id is stable for its lifetime).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  return (
    <div className={'terminal-pane' + (active ? ' active' : '')}>
      <div className="terminal-pane-surface" ref={containerRef} />
    </div>
  )
}
```

- [ ] **Step 2: Write `TerminalPane.css`**

```css
.terminal-pane {
  position: absolute;
  inset: 0;
  opacity: 0;
  z-index: 0;
  pointer-events: none;
}

.terminal-pane.active {
  opacity: 1;
  z-index: 1;
  pointer-events: auto;
}

@media (prefers-reduced-motion: no-preference) {
  .terminal-pane {
    transition: opacity var(--dur-fast) var(--ease-out);
  }
}

.terminal-pane-surface {
  width: 100%;
  height: 100%;
  padding: 8px;
  box-sizing: border-box;
  background: var(--bg-window);
}
```

- [ ] **Step 3: Write the test file**

Create `src/renderer/src/components/Terminal/TerminalPane.test.tsx`. Mock
`@xterm/xterm` and `@xterm/addon-fit` entirely (a real xterm.js instance
needs a real canvas/DOM measurement environment that plain vitest/jsdom does
not provide) — assert only the WIRING: that `terminal.create`'s id is used
for every bridge call, that `onTerminalData`/`onTerminalExit` are subscribed
and unsubscribed on unmount, and that a chunk delivered for a DIFFERENT id is
ignored.

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { TerminalPane } from './TerminalPane'

const fakeTerm = {
  loadAddon: vi.fn(),
  open: vi.fn(),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  write: vi.fn(),
  dispose: vi.fn(),
  cols: 80,
  rows: 24
}
vi.mock('@xterm/xterm', () => ({ Terminal: vi.fn(() => fakeTerm) }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(() => ({ fit: vi.fn() })) }))

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', FakeResizeObserver)

const dataListeners: Array<(id: string, chunk: string) => void> = []
const exitListeners: Array<(id: string) => void> = []
const markExited = vi.fn()

vi.mock('../../state/store', () => ({
  useAppStore: (selector: (s: { markTerminalTabExited: typeof markExited }) => unknown) =>
    selector({ markTerminalTabExited: markExited })
}))

vi.stubGlobal('bearcode', {
  terminal: { write: vi.fn(), resize: vi.fn() },
  onTerminalData: (cb: (id: string, chunk: string) => void) => {
    dataListeners.push(cb)
    return () => {
      const i = dataListeners.indexOf(cb)
      if (i >= 0) dataListeners.splice(i, 1)
    }
  },
  onTerminalExit: (cb: (id: string) => void) => {
    exitListeners.push(cb)
    return () => {
      const i = exitListeners.indexOf(cb)
      if (i >= 0) exitListeners.splice(i, 1)
    }
  }
})

beforeEach(() => {
  dataListeners.length = 0
  exitListeners.length = 0
  vi.clearAllMocks()
})

afterEach(cleanup)

describe('TerminalPane', () => {
  it('resizes on mount using the bridge with this pane\'s id', () => {
    render(<TerminalPane id="t1" path="/proj/a" active />)
    expect(window.bearcode.terminal.resize).toHaveBeenCalledWith('t1', 80, 24)
  })

  it('writes an incoming chunk for its own id into the terminal instance', () => {
    render(<TerminalPane id="t1" path="/proj/a" active />)
    dataListeners[0]('t1', 'hello')
    expect(fakeTerm.write).toHaveBeenCalledWith('hello')
  })

  it('ignores a chunk addressed to a different id', () => {
    render(<TerminalPane id="t1" path="/proj/a" active />)
    dataListeners[0]('other', 'hello')
    expect(fakeTerm.write).not.toHaveBeenCalled()
  })

  it('marks the tab exited when its own exit event fires', () => {
    render(<TerminalPane id="t1" path="/proj/a" active />)
    exitListeners[0]('t1')
    expect(markExited).toHaveBeenCalledWith('/proj/a', 't1')
  })

  it('disposes the terminal and unsubscribes on unmount', () => {
    const { unmount } = render(<TerminalPane id="t1" path="/proj/a" active />)
    unmount()
    expect(fakeTerm.dispose).toHaveBeenCalled()
    expect(dataListeners).toHaveLength(0)
    expect(exitListeners).toHaveLength(0)
  })
})
```

Add `import { afterEach } from 'vitest'` to the existing vitest import if the
project's vitest config does not already provide it as a global (check an
existing `*.test.tsx` file's imports for the established convention and match
it).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/renderer/src/components/Terminal/TerminalPane.test.tsx`
Expected: all tests pass.

- [ ] **Step 5: Run both tsc gates**

Run: `npx tsc --noEmit -p tsconfig.node.json` and `npx tsc --noEmit -p tsconfig.web.json`
Expected: no new errors beyond baseline.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/Terminal/TerminalPane.tsx src/renderer/src/components/Terminal/TerminalPane.css src/renderer/src/components/Terminal/TerminalPane.test.tsx
git commit -m "feat(terminal): add TerminalPane (xterm.js instance wired to the IPC bridge)"
```

---

### Task 5: `TerminalView` (tab strip) and `App.tsx` wiring

**Files:**
- Create: `src/renderer/src/components/Terminal/TerminalView.tsx`
- Create: `src/renderer/src/components/Terminal/TerminalView.css`
- Modify: `src/renderer/src/App.tsx`
- Test: `src/renderer/src/components/Terminal/TerminalView.test.tsx`

**Interfaces:**
- Consumes: `terminalTabs`, `activeTerminalTab`, `createTerminalTab`, `closeTerminalTab`, `setActiveTerminalTab` (Task 3), `TerminalPane` (Task 4), `window.bearcode.terminal.list` (Task 2, to hydrate on mount).
- Produces: `TerminalView` component with prop `{ path: string }`, rendered by `App.tsx` for `view.kind === 'terminal'`.

- [ ] **Step 1: Write `TerminalView.tsx`**

```tsx
import { useEffect } from 'react'
import { useAppStore } from '../../state/store'
import { useShallow } from 'zustand/react/shallow'
import { TerminalPane } from './TerminalPane'
import { IconPlus, IconClose, IconTerminal } from '../icons'
import './TerminalView.css'

export function TerminalView({ path }: { path: string }): React.JSX.Element {
  const tabs = useAppStore((s) => s.terminalTabs[path] ?? [])
  const activeId = useAppStore((s) => s.activeTerminalTab[path])
  const { createTerminalTab, closeTerminalTab, setActiveTerminalTab } = useAppStore(
    useShallow((s) => ({
      createTerminalTab: s.createTerminalTab,
      closeTerminalTab: s.closeTerminalTab,
      setActiveTerminalTab: s.setActiveTerminalTab
    }))
  )

  // Hydrate from any sessions the main process already has for this path
  // (e.g. this project's Terminal view was open earlier this app session,
  // then navigated away from and back to -- the ptys kept running). Only
  // seeds tabs when the store has none recorded for this path yet, so it
  // never fights a tab the user just created.
  useEffect(() => {
    if (tabs.length > 0) return
    void window.bearcode.terminal.list(path).then((sessions) => {
      if (sessions.length === 0) {
        void createTerminalTab(path)
        return
      }
      useAppStore.setState((s) => ({
        terminalTabs: {
          ...s.terminalTabs,
          [path]: sessions.map((v) => ({ id: v.id, title: v.title, exited: v.exited }))
        },
        activeTerminalTab: { ...s.activeTerminalTab, [path]: sessions[0].id }
      }))
    })
    // Runs once per path mount -- deliberately excludes `tabs`/`createTerminalTab`
    // from deps so it never re-fires as the tab list it just seeded changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  return (
    <div className="terminal-view">
      <div className="terminal-tabstrip">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={'terminal-tab' + (tab.id === activeId ? ' active' : '') + (tab.exited ? ' exited' : '')}
            onClick={() => setActiveTerminalTab(path, tab.id)}
          >
            <IconTerminal size={13} />
            <span>{tab.exited ? `${tab.title} (exited)` : tab.title}</span>
            <span
              className="terminal-tab-close"
              role="button"
              aria-label="Close terminal tab"
              onClick={(e) => {
                e.stopPropagation()
                void closeTerminalTab(path, tab.id)
              }}
            >
              <IconClose size={11} />
            </span>
          </button>
        ))}
        <button
          className="terminal-tab-new"
          aria-label="New terminal tab"
          onClick={() => void createTerminalTab(path)}
        >
          <IconPlus size={13} />
        </button>
      </div>
      <div className="terminal-panes">
        {tabs.map((tab) => (
          <TerminalPane key={tab.id} id={tab.id} path={path} active={tab.id === activeId} />
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Write `TerminalView.css`**

```css
.terminal-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.terminal-tabstrip {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-sidebar);
  flex-shrink: 0;
}

.terminal-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--text-mid);
  font-size: 12px;
  cursor: pointer;
}

.terminal-tab:hover {
  background: var(--bg-hover);
}

.terminal-tab.active {
  background: var(--bg-active);
  color: var(--text);
}

.terminal-tab.exited {
  color: var(--text-dim);
}

.terminal-tab-close {
  display: inline-flex;
  border-radius: 4px;
  padding: 2px;
}

.terminal-tab-close:hover {
  background: var(--bg-hover);
}

.terminal-tab-new {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px 6px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--text-mid);
  cursor: pointer;
}

.terminal-tab-new:hover {
  background: var(--bg-hover);
}

.terminal-panes {
  position: relative;
  flex: 1;
  min-height: 0;
}
```

- [ ] **Step 3: Wire into `App.tsx`**

Add the import alongside the other view components:

```ts
import { TerminalView } from './components/Terminal/TerminalView'
```

In the `main-view` div (the block containing `{view.kind === 'home' ? <Home /> : null}`
and `{view.kind === 'history' ? <HistoryView /> : null}`), add a third line
immediately after them:

```tsx
          {view.kind === 'terminal' ? <TerminalView path={view.path} /> : null}
```

- [ ] **Step 4: Write the test file**

Create `src/renderer/src/components/Terminal/TerminalView.test.tsx`. Mock
`TerminalPane` itself (this test is about the tab strip's behavior, not
xterm.js) and `window.bearcode.terminal.list`.

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useAppStore } from '../../state/store'
import { TerminalView } from './TerminalView'

vi.mock('./TerminalPane', () => ({
  TerminalPane: ({ id, active }: { id: string; active: boolean }) => (
    <div data-testid={`pane-${id}`} data-active={active} />
  )
}))

vi.stubGlobal('bearcode', {
  terminal: {
    list: vi.fn(async () => []),
    create: vi.fn(async (projectPath: string) => ({
      id: `t-${Math.random()}`,
      projectPath,
      title: 'zsh',
      createdAt: 0,
      exited: false
    })),
    close: vi.fn(async () => {})
  }
})

beforeEach(() => {
  useAppStore.setState({ terminalTabs: {}, activeTerminalTab: {} })
  vi.clearAllMocks()
})

describe('TerminalView', () => {
  it('creates an initial tab when the project has no existing sessions', async () => {
    render(<TerminalView path="/proj/a" />)
    await waitFor(() => expect(useAppStore.getState().terminalTabs['/proj/a']).toHaveLength(1))
  })

  it('hydrates from existing main-process sessions instead of creating a new one', async () => {
    vi.mocked(window.bearcode.terminal.list).mockResolvedValueOnce([
      { id: 'existing', projectPath: '/proj/a', title: 'zsh', createdAt: 0, exited: false }
    ])
    render(<TerminalView path="/proj/a" />)
    await waitFor(() => expect(useAppStore.getState().terminalTabs['/proj/a']).toHaveLength(1))
    expect(useAppStore.getState().terminalTabs['/proj/a'][0].id).toBe('existing')
    expect(window.bearcode.terminal.create).not.toHaveBeenCalled()
  })

  it('clicking + creates another tab and makes it active', async () => {
    useAppStore.setState({
      terminalTabs: { '/proj/a': [{ id: 't1', title: 'zsh', exited: false }] },
      activeTerminalTab: { '/proj/a': 't1' }
    })
    render(<TerminalView path="/proj/a" />)
    fireEvent.click(screen.getByLabelText('New terminal tab'))
    await waitFor(() => expect(useAppStore.getState().terminalTabs['/proj/a']).toHaveLength(2))
  })

  it('only the active tab\'s pane is marked active', () => {
    useAppStore.setState({
      terminalTabs: {
        '/proj/a': [
          { id: 't1', title: 'zsh', exited: false },
          { id: 't2', title: 'zsh', exited: false }
        ]
      },
      activeTerminalTab: { '/proj/a': 't2' }
    })
    render(<TerminalView path="/proj/a" />)
    expect(screen.getByTestId('pane-t1').dataset.active).toBe('false')
    expect(screen.getByTestId('pane-t2').dataset.active).toBe('true')
  })
})
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/renderer/src/components/Terminal/TerminalView.test.tsx`
Expected: all tests pass.

- [ ] **Step 6: Run both tsc gates**

Run: `npx tsc --noEmit -p tsconfig.node.json` and `npx tsc --noEmit -p tsconfig.web.json`
Expected: no new errors beyond baseline.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/Terminal/TerminalView.tsx src/renderer/src/components/Terminal/TerminalView.css src/renderer/src/App.tsx src/renderer/src/components/Terminal/TerminalView.test.tsx
git commit -m "feat(terminal): add TerminalView tab strip and wire it into App.tsx"
```

---

### Task 6: Sidebar entry point

**Files:**
- Modify: `src/renderer/src/components/Sidebar/Sidebar.tsx`
- Modify: `src/renderer/src/state/store.ts` (only if `openTerminalView` needs re-export — it does not, already added in Task 3; this task only wires the button)
- Test: `src/renderer/src/components/Sidebar/Sidebar.terminal.test.tsx`

**Interfaces:**
- Consumes: `openTerminalView` action (Task 3), `IconTerminal` (already exists in `src/renderer/src/components/icons.tsx`, unused elsewhere today — no icon file changes needed).

- [ ] **Step 1: Add the button**

In `src/renderer/src/components/Sidebar/Sidebar.tsx`, add `openTerminalView`
to the store selectors near the top of the component, alongside
`openProjectSettings`:

```ts
  const openTerminalView = useAppStore((s) => s.openTerminalView)
```

Add `IconTerminal` to the existing icons import:

```ts
import { IconArchive, IconHistory, IconPanel, IconPin, IconPlus, IconSettings, IconTerminal } from '../icons'
```

In the `.proj-actions` block (the same block containing the gear and +
buttons), add a third `Hint`-wrapped `row-act` button between them (matching
the existing "gear then +" order comment, becoming "gear, terminal, +"):

```tsx
                      <Hint label="Open terminal" side="bottom">
                        <button
                          className="row-act"
                          aria-label="Open terminal"
                          onClick={(e) => {
                            e.stopPropagation()
                            openTerminalView(path)
                          }}
                        >
                          <IconTerminal size={13} />
                        </button>
                      </Hint>
```

Insert it between the existing gear (`Project settings`) button and the +
(`New conversation in this folder`) button, updating the leading comment
from `{/* Order matches Antigravity: gear (settings) then + (new). */}` to
`{/* Order: gear (settings), terminal, + (new). */}`.

- [ ] **Step 2: Write the test file**

Create `src/renderer/src/components/Sidebar/Sidebar.terminal.test.tsx`,
following the same rendering/mocking setup as the existing
`Sidebar.test.tsx` (import its store-seeding helpers/mocks if it exports any
reusable setup, otherwise replicate its minimal store-seed pattern for a
single folder group with one conversation).

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useAppStore } from '../../state/store'
import { Sidebar } from './Sidebar'

describe('Sidebar terminal entry point', () => {
  it('clicking the terminal row-act button opens the terminal view for that folder', () => {
    useAppStore.setState((s) => ({
      ...s,
      conversations: {
        c1: {
          id: 'c1',
          title: 'Convo',
          projectPath: '/proj/a',
          projectLabel: 'a',
          events: [],
          runState: 'done',
          modelRef: 'anthropic/claude-sonnet-5',
          pinned: false,
          archived: false
        }
      },
      convoOrder: ['c1'],
      folderSettings: [],
      view: { kind: 'home' }
    }))
    render(<Sidebar />)
    fireEvent.click(screen.getByLabelText('Open terminal'))
    expect(useAppStore.getState().view).toEqual({ kind: 'terminal', path: '/proj/a' })
  })
})
```

If the store's `Conversation` shape in this codebase has additional required
fields beyond the ones above, check an existing `Sidebar.*.test.tsx` file
(e.g. `Sidebar.pinArchive.test.tsx`) for the real shape and match it exactly
— the fields above are illustrative of the minimum needed to render one
folder group, not necessarily complete.

- [ ] **Step 3: Run the tests**

Run: `npx vitest run src/renderer/src/components/Sidebar/Sidebar.terminal.test.tsx`
Expected: all tests pass.

- [ ] **Step 4: Run both tsc gates**

Run: `npx tsc --noEmit -p tsconfig.node.json` and `npx tsc --noEmit -p tsconfig.web.json`
Expected: no new errors beyond baseline.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/Sidebar/Sidebar.tsx src/renderer/src/components/Sidebar/Sidebar.terminal.test.tsx
git commit -m "feat(terminal): add sidebar entry point for the terminal view"
```

---

### Task 7: Final verification (full suite, packaged build, live smoke)

**Files:** none (verification only — no new source changes expected; only
fix regressions this step uncovers).

**Interfaces:** none — this task consumes the entire feature built in Tasks 1-6.

- [ ] **Step 1: Run the full test suite fresh**

Run: `npx vitest run`
Expected: every test file passes, including all new terminal test files
from Tasks 1-6.

- [ ] **Step 2: Run both tsc gates**

Run: `npx tsc --noEmit -p tsconfig.node.json` and `npx tsc --noEmit -p tsconfig.web.json`
Expected: at or under the documented baseline (17 node-tc / 2 web-tc).

- [ ] **Step 3: Boot the dev build**

Run `npm run dev` (or the project's electron-vite dev command), confirm main
+ preload + renderer all build and Electron launches without a crash. Kill
any stale `electron-vite`/`electron` processes first per `CLAUDE.md`'s
dev-server hygiene rule.

- [ ] **Step 4: Verify the native dependency in a PACKAGED build**

`node-pty` is a native addon — passing under `electron-vite dev` does not
guarantee it loads correctly once packaged (per the spec's explicit risk
callout). Run the project's packaging command (check `package.json`'s
`scripts` for the existing `build`/`dist`/`package` script used by prior
release work — do not invent a new one) for at least the current
architecture, then launch the packaged app and open the Terminal view for
any project. If the pty fails to spawn (a missing/incompatible native binary
would surface as an immediate error opening any terminal tab), this is a
Critical finding — report it rather than working around it with a
downgrade or a different pty library substitution without asking.

- [ ] **Step 5: Hand off the interactive smoke checklist**

Automated tests cannot meaningfully drive a real pty running an interactive
CLI. Report the following checklist to your human partner for their own
live smoke test, rather than attempting to script it:

- Open a project folder, click the new terminal icon in its sidebar row —
  the Terminal view opens with one tab and a working shell prompt.
- Run `claude` in the tab; confirm it launches, prompts render correctly
  (including its own permission prompts), and interactive keystrokes work.
- Run `codex` in a second tab (via the `+` button); confirm both tabs keep
  running independently and switching between them preserves each one's
  scrollback.
- Resize the BearCode window; confirm the terminal reflows (no clipped
  output, cursor position stays correct).
- Type `exit` in one tab; confirm it shows an "(exited)" state rather than
  going blank, and can still be closed.
- Toggle Dark/Light/Custom theme in Settings → Appearance; confirm the
  terminal's colors follow along rather than looking foreign.
- Quit BearCode with a terminal tab still running a long-lived process
  (e.g. `claude` mid-conversation); confirm no orphaned shell process
  remains after quit (check `ps` for a lingering `zsh`/`claude` process
  tied to the quit app).

- [ ] **Step 6: No commit for this task**

This task is verification-only. If Steps 1-4 turn up regressions, fix them
as small targeted commits referencing which earlier task's work they
correct, rather than one large end-of-plan commit.
