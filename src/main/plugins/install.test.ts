import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync } from 'fs'
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

describe('install flow', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k]
    vi.resetModules()
  })
  it('confirmInstall copies a staged plugin into the global plugins dir (jailed)', async () => {
    const { confirmInstall } = await import('./marketplace')
    const { pluginsDir } = await import('./index')
    const stage = mkdtempSync(join(tmpdir(), 'bc-stage-'))
    writeFileSync(join(stage, 'plugin.json'), JSON.stringify({ name: 'copied' }))
    confirmInstall(stage)
    expect(existsSync(join(pluginsDir('global', null), 'copied', 'plugin.json'))).toBe(true)
  })
  it('confirmInstall rejects a staged plugin whose name is not kebab/traversal-safe', async () => {
    const { confirmInstall } = await import('./marketplace')
    const stage = mkdtempSync(join(tmpdir(), 'bc-stage-'))
    writeFileSync(join(stage, 'plugin.json'), JSON.stringify({ name: '../evil' }))
    expect(() => confirmInstall(stage)).toThrow(/kebab|traversal/i)
  })
})
