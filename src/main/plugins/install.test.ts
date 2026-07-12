import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const store: Record<string, unknown> = {}
vi.mock('../settings', () => ({
  getSettings: () => store,
  setSettings: (p: Record<string, unknown>) => Object.assign(store, p)
}))
// stub safeClone to copy a local fixture instead of hitting the network
vi.mock('./marketplace', async (orig) => {
  const actual = await orig<typeof import('./marketplace')>()
  return actual
})
// confirmInstall always targets pluginsDir('global', null), which resolves
// via os.homedir() -- redirect that to a scratch dir per test so this suite
// never writes a real 'copied' plugin folder into the developer's/CI's
// actual home directory (mirrors index.test.ts's project-scope-only
// approach, but confirmInstall has no scope param to swap instead).
let fakeHome: string
vi.mock('os', async (orig) => {
  const actual = await orig<typeof import('os')>()
  return { ...actual, homedir: () => fakeHome }
})

describe('install flow', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k]
    vi.resetModules()
    fakeHome = mkdtempSync(join(tmpdir(), 'bc-home-'))
  })
  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true })
  })
  it('confirmInstall copies a staged plugin into the global plugins dir (jailed)', async () => {
    const { confirmInstall, stageRoot } = await import('./marketplace')
    const { pluginsDir } = await import('./index')
    mkdirSync(stageRoot(), { recursive: true })
    const stage = mkdtempSync(join(stageRoot(), 'bc-stage-'))
    writeFileSync(join(stage, 'plugin.json'), JSON.stringify({ name: 'copied' }))
    confirmInstall(stage)
    expect(existsSync(join(pluginsDir('global', null), 'copied', 'plugin.json'))).toBe(true)
  })
  it('confirmInstall rejects a staged plugin whose name is not kebab/traversal-safe', async () => {
    const { confirmInstall, stageRoot } = await import('./marketplace')
    mkdirSync(stageRoot(), { recursive: true })
    const stage = mkdtempSync(join(stageRoot(), 'bc-stage-'))
    writeFileSync(join(stage, 'plugin.json'), JSON.stringify({ name: '../evil' }))
    expect(() => confirmInstall(stage)).toThrow(/kebab|traversal/i)
  })
  it('confirmInstall rejects a stagePath outside stageRoot() even with a valid manifest', async () => {
    const { confirmInstall } = await import('./marketplace')
    // Simulates a caller (e.g. an IPC handler that only checks `typeof
    // stage === 'string'`) pointing confirmInstall at an arbitrary directory
    // that was never produced by prepareInstall.
    const outside = mkdtempSync(join(tmpdir(), 'bc-outside-'))
    writeFileSync(join(outside, 'plugin.json'), JSON.stringify({ name: 'sneaky' }))
    expect(() => confirmInstall(outside)).toThrow(/previously prepared install stage/i)
  })
})
