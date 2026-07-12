import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const store: Record<string, unknown> = {}
vi.mock('../settings', () => ({
  getSettings: () => store,
  setSettings: (p: Record<string, unknown>) => Object.assign(store, p)
}))

// writeGlobalHook/deleteGlobalHook and loadHooks both resolve the global
// hooks.json off os.homedir() -- point it at a fresh mkdtempSync temp dir
// per test (mirrors loader.test.ts) so this never touches the developer's
// real ~/.bearcode.
let fakeHome = ''
vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  homedir: () => fakeHome
}))

describe('writeGlobalHook / deleteGlobalHook (path-jailed)', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k]
    vi.resetModules()
    fakeHome = mkdtempSync(join(tmpdir(), 'bc-hooks-author-'))
  })
  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true })
  })

  it('writes a global hook that loadHooks(null) then surfaces', async () => {
    const { writeGlobalHook } = await import('./authoring')
    const { loadHooks } = await import('./loader')

    writeGlobalHook({
      name: 'guard-rm',
      event: 'PreToolUse',
      matcher: 'run_command',
      command: 'node ~/.bearcode/guard.js'
    })

    const recs = loadHooks(null)
    expect(recs).toEqual([
      {
        name: 'guard-rm',
        scope: 'global',
        event: 'PreToolUse',
        matcher: 'run_command',
        command: 'node ~/.bearcode/guard.js',
        timeout: 30,
        consented: true
      }
    ])
  })

  it('deleteGlobalHook removes it so loadHooks(null) no longer surfaces it', async () => {
    const { writeGlobalHook, deleteGlobalHook } = await import('./authoring')
    const { loadHooks } = await import('./loader')

    writeGlobalHook({
      name: 'guard-rm',
      event: 'PreToolUse',
      matcher: 'run_command',
      command: 'node guard.js'
    })
    expect(loadHooks(null)).toHaveLength(1)

    deleteGlobalHook('guard-rm')
    expect(loadHooks(null)).toEqual([])
  })

  it('a second write for another event on the same name preserves the first event', async () => {
    const { writeGlobalHook } = await import('./authoring')
    const { loadHooks } = await import('./loader')

    writeGlobalHook({
      name: 'multi',
      event: 'PreToolUse',
      matcher: 'run_command',
      command: 'pre.js'
    })
    writeGlobalHook({
      name: 'multi',
      event: 'PostToolUse',
      matcher: 'edit_file',
      command: 'post.js',
      timeout: 5
    })

    const recs = loadHooks(null)
    expect(recs).toHaveLength(2)
    expect(recs.find((r) => r.event === 'PreToolUse')).toMatchObject({ command: 'pre.js' })
    expect(recs.find((r) => r.event === 'PostToolUse')).toMatchObject({
      command: 'post.js',
      timeout: 5
    })
  })

  it('updateGlobalHook: renaming a dual-event hook keeps its other event', async () => {
    const { writeGlobalHook, updateGlobalHook } = await import('./authoring')
    const { loadHooks } = await import('./loader')

    writeGlobalHook({
      name: 'multi',
      event: 'PreToolUse',
      matcher: 'run_command',
      command: 'pre.js'
    })
    writeGlobalHook({
      name: 'multi',
      event: 'PostToolUse',
      matcher: 'edit_file',
      command: 'post.js',
      timeout: 5
    })
    expect(loadHooks(null)).toHaveLength(2)

    // Rename 'multi' -> 'renamed', editing only the PreToolUse entry.
    updateGlobalHook(
      { name: 'multi', event: 'PreToolUse', matcher: 'run_command', command: 'pre.js' },
      { name: 'renamed', event: 'PreToolUse', matcher: 'run_command', command: 'pre2.js' }
    )

    const recs = loadHooks(null)
    expect(recs).toHaveLength(2)
    // The renamed entry moved and picked up the edit.
    expect(recs.find((r) => r.event === 'PreToolUse')).toMatchObject({
      name: 'renamed',
      command: 'pre2.js'
    })
    // The other event survived the rename under the SAME new name (it
    // belonged to the same logical hook), not orphaned under the old name.
    expect(recs.find((r) => r.event === 'PostToolUse')).toMatchObject({
      name: 'renamed',
      command: 'post.js',
      timeout: 5
    })
  })

  it('updateGlobalHook: editing one entry preserves a sibling entry under the same event', async () => {
    const { writeGlobalHook, updateGlobalHook } = await import('./authoring')
    const { loadHooks } = await import('./loader')

    writeGlobalHook({
      name: 'guard',
      event: 'PreToolUse',
      matcher: 'run_command',
      command: 'guard-a.js'
    })
    // Hand-author a second entry under the same event/name by writing the
    // full map directly (writeGlobalHook itself always replaces the array,
    // which is exactly the collapsing behavior this test guards against).
    const { readFileSync, writeFileSync } = await import('fs')
    const { join: pathJoin } = await import('path')
    const file = pathJoin(fakeHome, '.bearcode', 'agents', 'hooks.json')
    const map = JSON.parse(readFileSync(file, 'utf8'))
    map.guard.PreToolUse.push({
      matcher: 'edit_file',
      handler: { type: 'command', command: 'guard-b.js' }
    })
    writeFileSync(file, JSON.stringify(map))
    expect(loadHooks(null)).toHaveLength(2)

    updateGlobalHook(
      { name: 'guard', event: 'PreToolUse', matcher: 'run_command', command: 'guard-a.js' },
      { name: 'guard', event: 'PreToolUse', matcher: 'run_command', command: 'guard-a2.js' }
    )

    const recs = loadHooks(null)
    expect(recs).toHaveLength(2)
    expect(recs.find((r) => r.matcher === 'run_command')).toMatchObject({ command: 'guard-a2.js' })
    expect(recs.find((r) => r.matcher === 'edit_file')).toMatchObject({ command: 'guard-b.js' })
  })

  it('rejects a non-kebab name on write and delete', async () => {
    const { writeGlobalHook, deleteGlobalHook } = await import('./authoring')
    expect(() =>
      writeGlobalHook({
        name: '../evil',
        event: 'PreToolUse',
        matcher: '',
        command: 'x'
      })
    ).toThrow(/kebab/i)
    expect(() => deleteGlobalHook('Not_Kebab')).toThrow(/kebab/i)
  })
})
