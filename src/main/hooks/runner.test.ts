import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__')

const store: Record<string, unknown> = {}
vi.mock('../settings', () => ({
  getSettings: () => store,
  setSettings: (p: Record<string, unknown>) => Object.assign(store, p)
}))

// loadHooks reads the global hooks.json off os.homedir() -- point it at a
// fresh mkdtempSync temp dir per test (mirrors loader.test.ts) so this never
// touches the developer's real ~/.bearcode.
let fakeHome = ''
vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  homedir: () => fakeHome
}))

function writeGlobalHooks(config: Record<string, unknown>): void {
  const dir = join(fakeHome, '.bearcode', 'agents')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'hooks.json'), JSON.stringify(config))
}

function commandFor(fixture: string): string {
  return `sh ${join(FIXTURES, fixture)}`
}

describe('hook runner', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k]
    vi.resetModules()
    fakeHome = mkdtempSync(join(tmpdir(), 'bc-hooks-runner-home-'))
  })
  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true })
  })

  it('honors a deny decision, with reason, and does not need to read stdin', async () => {
    writeGlobalHooks({
      guard: {
        PreToolUse: [
          { matcher: 'toolA', handler: { type: 'command', command: commandFor('deny.sh') } }
        ]
      }
    })
    const { runPreToolUse } = await import('./runner')
    const decision = await runPreToolUse(
      'toolA',
      {},
      {
        projectPath: null,
        conversationId: 'c1',
        trusted: false
      }
    )
    expect(decision).toEqual({ decision: 'deny', reason: 'blocked by policy' })
  })

  it('honors an allow decision', async () => {
    writeGlobalHooks({
      ok: {
        PreToolUse: [
          { matcher: 'toolB', handler: { type: 'command', command: commandFor('allow.sh') } }
        ]
      }
    })
    const { runPreToolUse } = await import('./runner')
    const decision = await runPreToolUse(
      'toolB',
      { a: 1 },
      {
        projectPath: null,
        conversationId: 'c1',
        trusted: false
      }
    )
    expect(decision).toEqual({ decision: 'allow' })
  })

  it('honors an ask decision, with reason', async () => {
    writeGlobalHooks({
      confirm: {
        PreToolUse: [
          { matcher: 'toolC', handler: { type: 'command', command: commandFor('ask.sh') } }
        ]
      }
    })
    const { runPreToolUse } = await import('./runner')
    const decision = await runPreToolUse(
      'toolC',
      {},
      {
        projectPath: null,
        conversationId: 'c1',
        trusted: false
      }
    )
    expect(decision).toEqual({ decision: 'ask', reason: 'confirm this' })
  })

  it('most-restrictive-wins: deny beats allow across multiple matching hooks', async () => {
    writeGlobalHooks({
      ok: {
        PreToolUse: [
          { matcher: 'toolD', handler: { type: 'command', command: commandFor('allow.sh') } }
        ]
      },
      guard: {
        PreToolUse: [
          { matcher: 'toolD', handler: { type: 'command', command: commandFor('deny.sh') } }
        ]
      }
    })
    const { runPreToolUse } = await import('./runner')
    const decision = await runPreToolUse(
      'toolD',
      {},
      {
        projectPath: null,
        conversationId: 'c1',
        trusted: false
      }
    )
    expect(decision.decision).toBe('deny')
  })

  it('a timed-out hook fails open (allow), never lets its stale output through', async () => {
    writeGlobalHooks({
      slow: {
        PreToolUse: [
          {
            matcher: 'toolE',
            handler: { type: 'command', command: commandFor('sleeper.sh'), timeout: 1 }
          }
        ]
      }
    })
    const { runPreToolUse } = await import('./runner')
    const decision = await runPreToolUse(
      'toolE',
      {},
      {
        projectPath: null,
        conversationId: 'c1',
        trusted: false
      }
    )
    expect(decision).toEqual({ decision: 'allow' })
  }, 10000)

  it('a hook that traps and ignores SIGTERM still fails open (allow) within the deadline', async () => {
    writeGlobalHooks({
      hostile: {
        PreToolUse: [
          {
            matcher: 'toolE2',
            handler: { type: 'command', command: commandFor('trap-term.sh'), timeout: 1 }
          }
        ]
      }
    })
    const { runPreToolUse } = await import('./runner')
    const decision = await runPreToolUse(
      'toolE2',
      {},
      {
        projectPath: null,
        conversationId: 'c1',
        trusted: false
      }
    )
    expect(decision).toEqual({ decision: 'allow' })
  }, 10000)

  it('malformed stdout fails open (allow)', async () => {
    writeGlobalHooks({
      junk: {
        PreToolUse: [
          { matcher: 'toolF', handler: { type: 'command', command: commandFor('garbage.sh') } }
        ]
      }
    })
    const { runPreToolUse } = await import('./runner')
    const decision = await runPreToolUse(
      'toolF',
      {},
      {
        projectPath: null,
        conversationId: 'c1',
        trusted: false
      }
    )
    expect(decision).toEqual({ decision: 'allow' })
  })

  it('matcher filters by tool name -- a non-matching tool sees no hooks and allows', async () => {
    writeGlobalHooks({
      guard: {
        PreToolUse: [
          { matcher: 'toolG', handler: { type: 'command', command: commandFor('deny.sh') } }
        ]
      }
    })
    const { runPreToolUse } = await import('./runner')
    const decision = await runPreToolUse(
      'somethingElse',
      {},
      {
        projectPath: null,
        conversationId: 'c1',
        trusted: false
      }
    )
    expect(decision).toEqual({ decision: 'allow' })
  })

  it('PostToolUse never throws, even when the matching hook prints garbage', async () => {
    writeGlobalHooks({
      obs: {
        PostToolUse: [
          { matcher: 'toolH', handler: { type: 'command', command: commandFor('garbage.sh') } }
        ]
      }
    })
    const { runPostToolUse } = await import('./runner')
    await expect(
      runPostToolUse(
        'toolH',
        {},
        true,
        { ok: true },
        {
          projectPath: null,
          conversationId: 'c1',
          trusted: false
        }
      )
    ).resolves.toBeUndefined()
  })
})
