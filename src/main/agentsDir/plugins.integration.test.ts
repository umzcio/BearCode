import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const store: Record<string, unknown> = {}
vi.mock('../settings', () => ({
  getSettings: () => ({ pluginsEnabled: (store.pluginsEnabled as string[]) ?? [] }),
  setSettings: (p: Record<string, unknown>) => Object.assign(store, p)
}))

describe('loadAgentsContent + plugins', () => {
  beforeEach(() => { for (const k of Object.keys(store)) delete store[k]; vi.resetModules() })
  it('surfaces an enabled global plugin skill with plugin provenance', async () => {
    const { pluginsDir } = await import('../plugins')
    const p = join(pluginsDir('global', null), 'gp')
    mkdirSync(join(p, 'skills', 'ps'), { recursive: true })
    writeFileSync(join(p, 'plugin.json'), '{}')
    writeFileSync(join(p, 'skills', 'ps', 'SKILL.md'), '---\nname: ps\ndescription: d\n---\nb')
    store.pluginsEnabled = ['global:gp']
    const { loadAgentsContent } = await import('./index')
    const skill = loadAgentsContent(null, { trusted: false }).skills.find((s) => s.name === 'ps')
    expect(skill?.plugin).toBe('gp')
  })
  it('direct project skill wins over a plugin skill of the same name', async () => {
    const proj = mkdtempSync(join(tmpdir(), 'bc-proj-'))
    mkdirSync(join(proj, '.agents', 'skills', 'dup'), { recursive: true })
    writeFileSync(join(proj, '.agents', 'skills', 'dup', 'SKILL.md'), '---\nname: dup\ndescription: direct\n---\nb')
    const { pluginsDir } = await import('../plugins')
    const p = join(pluginsDir('global', null), 'gp2')
    mkdirSync(join(p, 'skills', 'dup'), { recursive: true })
    writeFileSync(join(p, 'plugin.json'), '{}')
    writeFileSync(join(p, 'skills', 'dup', 'SKILL.md'), '---\nname: dup\ndescription: plugin\n---\nb')
    store.pluginsEnabled = ['global:gp2']
    const { loadAgentsContent } = await import('./index')
    const dup = loadAgentsContent(proj, { trusted: true }).skills.find((s) => s.name === 'dup')
    expect(dup?.description).toBe('direct'); expect(dup?.plugin).toBeUndefined()
  })
})
