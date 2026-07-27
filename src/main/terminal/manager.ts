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
//
// This also returns a *copy* of `process.env`, which means node-pty's own
// identity check (`opt.env === process.env`) in `_sanitizeEnv()` never fires
// for the object we pass -- so we replicate that sanitization here: strip the
// terminal-multiplexer/geometry vars it would otherwise strip, so they don't
// leak into the spawned shell and misrender full-screen TUIs (COLUMNS/LINES
// in particular would contradict the real pty geometry FitAddon negotiates).
const LEAKED_ENV_KEYS = [
  'TMUX',
  'TMUX_PANE',
  'STY',
  'WINDOW',
  'WINDOWID',
  'TERMCAP',
  'COLUMNS',
  'LINES'
] as const

function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) out[k] = v
  }
  for (const key of LEAKED_ENV_KEYS) {
    delete out[key]
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
      name: 'xterm-256color',
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
      this.killSession(session.pty.pid)
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
        this.killSession(session.pty.pid)
      }
    }
    this.sessions.clear()
  }

  // Sends SIGHUP to the shell's own process group first (process.kill with a negative
  // pid targets the group, not the single process) so any process that never left the
  // shell's own group (e.g. a future non-interactive/non-job-control shell mode) dies
  // with it. Job-controlled background jobs (`cmd &`) get their own separate pgid and
  // are unaffected by this either way -- they're already reaped by bash/zsh's own
  // SIGHUP-to-jobs handling before the shell exits (see the plan's "Recon finding").
  // Falls back to a plain single-PID kill if the group form throws (e.g. a pty backend
  // where the child was never made its own group leader). The pty wrapper's own kill
  // method is NOT used here -- node-pty's UnixTerminal.kill() swallows its own errors
  // internally (unixTerminal.js), which would make the fallback undetectable.
  private killSession(pid: number): void {
    try {
      process.kill(-pid, 'SIGHUP')
    } catch {
      try {
        process.kill(pid, 'SIGHUP')
      } catch {
        // Already dead.
      }
    }
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
