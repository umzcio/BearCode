import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const store: Record<string, unknown> = {}
vi.mock('../settings', () => ({
  getSettings: () => ({ pluginsEnabled: (store.pluginsEnabled as string[]) ?? [] }),
  setSettings: (p: Record<string, unknown>) => Object.assign(store, p)
}))

// pluginsDir('global', null) resolves off os.homedir() (src/main/plugins/
// index.ts), so without this mock the it() blocks below would write real
// fixture directories straight into the developer's/CI runner's actual home
// (~/.bearcode/agents/plugins/gp, gp2, gp3, gp4) with no teardown. Point
// homedir() at a fresh mkdtempSync temp dir per test (mirrors
// plugins/enumerate.test.ts and mcp/plugins.test.ts) and remove it in
// afterEach.
let fakeHome = ''
vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  homedir: () => fakeHome
}))

describe('loadAgentsContent + plugins', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k]
    vi.resetModules()
    fakeHome = mkdtempSync(join(tmpdir(), 'bc-agentsdir-plugin-'))
  })
  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true })
  })
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
  it('collision detection keys on the frontmatter-declared name, not the folder name', async () => {
    const proj = mkdtempSync(join(tmpdir(), 'bc-proj-'))
    mkdirSync(join(proj, '.agents', 'skills', 'shared-name'), { recursive: true })
    writeFileSync(
      join(proj, '.agents', 'skills', 'shared-name', 'SKILL.md'),
      '---\nname: shared-name\ndescription: direct\n---\nb'
    )
    const { pluginsDir } = await import('../plugins')
    // Plugin folder is named "beta" -- deliberately different from the
    // frontmatter `name:` it declares, which spoofs the direct skill's name.
    const p = join(pluginsDir('global', null), 'gp3')
    mkdirSync(join(p, 'skills', 'beta'), { recursive: true })
    writeFileSync(join(p, 'plugin.json'), '{}')
    writeFileSync(
      join(p, 'skills', 'beta', 'SKILL.md'),
      '---\nname: shared-name\ndescription: plugin\n---\nb'
    )
    store.pluginsEnabled = ['global:gp3']
    const { loadAgentsContent } = await import('./index')
    const skills = loadAgentsContent(proj, { trusted: true }).skills.filter(
      (s) => s.name === 'shared-name'
    )
    // Exactly one entry -- the plugin's spoofed-name skill must be dropped as
    // a collision, not inserted under its folder name as a second entry.
    expect(skills).toHaveLength(1)
    expect(skills[0].description).toBe('direct')
    expect(skills[0].plugin).toBeUndefined()
  })
  it('loads a plugin skill under its frontmatter name-override with NO collision, from a differently-named folder', async () => {
    const { pluginsDir } = await import('../plugins')
    // Folder is "actual-folder-name" but the SKILL.md declares a different
    // `name:` -- the documented name-override feature (design 4.1). Nothing
    // else on the system uses "declared-name", so this must load cleanly;
    // if enumeratePluginIngredients builds the path from the frontmatter
    // name instead of the real folder, this skill silently vanishes.
    const p = join(pluginsDir('global', null), 'gp4')
    mkdirSync(join(p, 'skills', 'actual-folder-name'), { recursive: true })
    writeFileSync(join(p, 'plugin.json'), '{}')
    writeFileSync(
      join(p, 'skills', 'actual-folder-name', 'SKILL.md'),
      '---\nname: declared-name\ndescription: overridden\n---\nb'
    )
    store.pluginsEnabled = ['global:gp4']
    const { loadAgentsContent } = await import('./index')
    const skill = loadAgentsContent(null, { trusted: false }).skills.find(
      (s) => s.name === 'declared-name'
    )
    expect(skill).toBeDefined()
    expect(skill?.description).toBe('overridden')
    expect(skill?.plugin).toBe('gp4')
  })
})
