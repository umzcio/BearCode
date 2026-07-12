import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const store: Record<string, unknown> = {}
vi.mock('../settings', () => ({
  getSettings: () => store,
  setSettings: (p: Record<string, unknown>) => Object.assign(store, p)
}))

// pluginsDir('global', null) and globalHooksPath() both resolve off
// os.homedir() -- point it at a fresh mkdtempSync temp dir per test (mirrors
// plugins/enumerate.test.ts) so this never touches the developer's real
// ~/.bearcode.
let fakeHome = ''
vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  homedir: () => fakeHome
}))

function writeHooksFile(dir: string, body: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'hooks.json'), body)
}

const GLOBAL_HOOK = JSON.stringify({
  fmt: {
    PostToolUse: [
      { matcher: 'edit', handler: { type: 'command', command: 'prettier', timeout: 10 } }
    ]
  }
})

describe('loadHooks', () => {
  let projectDir: string

  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k]
    vi.resetModules()
    fakeHome = mkdtempSync(join(tmpdir(), 'bc-hooks-home-'))
    projectDir = mkdtempSync(join(tmpdir(), 'bc-hooks-proj-'))
  })
  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('loads global hooks (always) with consented:true by default', async () => {
    const { loadHooks } = await import('./loader')
    writeHooksFile(join(fakeHome, '.bearcode', 'agents'), GLOBAL_HOOK)
    const recs = loadHooks(null)
    expect(recs).toEqual([
      {
        name: 'fmt',
        scope: 'global',
        event: 'PostToolUse',
        matcher: 'edit',
        command: 'prettier',
        timeout: 10,
        consented: true
      }
    ])
  })

  it('suppresses project hooks when untrusted, includes + stamps consent when trusted', async () => {
    const { loadHooks } = await import('./loader')
    writeHooksFile(
      join(projectDir, '.agents'),
      JSON.stringify({
        guard: { PreToolUse: [{ handler: { type: 'command', command: 'g' } }] }
      })
    )
    store.hooksConsented = [`project:${projectDir}:guard`]

    expect(loadHooks(projectDir, { trusted: false })).toEqual([])

    const recs = loadHooks(projectDir, { trusted: true })
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({ name: 'guard', scope: 'project', consented: true })
  })

  it('tags plugin hooks with the plugin dirName and stamps consent', async () => {
    const { loadHooks } = await import('./loader')
    const { pluginsDir } = await import('../plugins')
    const dir = join(pluginsDir('global', null), 'my-plugin')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'plugin.json'), '{}')
    writeFileSync(
      join(dir, 'hooks.json'),
      JSON.stringify({
        scan: { PreToolUse: [{ handler: { type: 'command', command: 's' } }] }
      })
    )
    store.pluginsEnabled = ['global:my-plugin']
    store.hooksConsented = ['plugin:my-plugin:scan']

    const recs = loadHooks(null)
    const scan = recs.find((r) => r.name === 'scan')
    expect(scan).toMatchObject({ scope: 'plugin', plugin: 'my-plugin', consented: true })
  })

  it('never throws on a missing/malformed hooks.json and no project', () => {
    expect(async () => {
      const { loadHooks } = await import('./loader')
      loadHooks(null)
    }).not.toThrow()
  })
})
