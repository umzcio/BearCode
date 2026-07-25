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

  it('spawns with a 256-color terminfo name, never the 8-color xterm-color', () => {
    // Regression test: node-pty forces env.TERM to whatever `name` is passed,
    // overriding any inherited value. `xterm-color` degrades every TUI
    // (including `claude`/`codex`, which probe TERM/COLORTERM) to 8/16 colors.
    terminalManager.create('/proj/a')
    const spawnMock = vi.mocked(pty.spawn)
    const opts = spawnMock.mock.calls.at(-1)?.[2] as { name?: string }
    expect(opts.name).toBe('xterm-256color')
  })

  it('never leaks terminal-multiplexer/geometry env vars into the spawned shell', () => {
    // Regression test: node-pty only runs its own `_sanitizeEnv()` (which
    // strips these same vars) when `opt.env === process.env` by identity.
    // Passing a *copy* (as `cleanEnv` must, to satisfy the type signature)
    // defeats that check, so `cleanEnv` itself must strip them.
    const leaked = {
      TMUX: '/tmp/tmux-1000/default,1234,0',
      TMUX_PANE: '%0',
      STY: '1234.pts-0.host',
      WINDOW: '0',
      WINDOWID: '12345',
      TERMCAP: 'xterm-256color:...',
      COLUMNS: '80',
      LINES: '24'
    }
    Object.assign(process.env, leaked)
    try {
      terminalManager.create('/proj/a')
      const spawnMock = vi.mocked(pty.spawn)
      const opts = spawnMock.mock.calls.at(-1)?.[2] as { env?: Record<string, string> }
      for (const key of [
        'TMUX',
        'TMUX_PANE',
        'STY',
        'WINDOW',
        'WINDOWID',
        'TERMCAP',
        'COLUMNS',
        'LINES'
      ]) {
        expect(opts.env).not.toHaveProperty(key)
      }
    } finally {
      for (const key of Object.keys(leaked)) delete process.env[key]
    }
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
