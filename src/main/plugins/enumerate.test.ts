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
// index.ts), so the first test case's global-scope fullPlugin() calls below
// would otherwise write real 'onpack'/'offpack' fixture directories straight
// into the developer's/CI runner's actual home (~/.bearcode/agents/plugins/)
// with no teardown. Point homedir() at a fresh mkdtempSync temp dir per test
// (mirrors mcp/plugins.test.ts) and remove it in afterEach.
let fakeHome = ''
vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  homedir: () => fakeHome
}))

function fullPlugin(root: string, name: string): void {
  const p = join(root, name)
  mkdirSync(join(p, 'skills', 's1'), { recursive: true })
  mkdirSync(join(p, 'rules'), { recursive: true })
  writeFileSync(join(p, 'plugin.json'), '{}')
  writeFileSync(join(p, 'skills', 's1', 'SKILL.md'), '---\nname: s1\ndescription: d\n---\nb')
  writeFileSync(join(p, 'rules', 'r1.md'), '---\nactivation: always\ndescription: d\n---\nb')
  writeFileSync(join(p, 'mcp.json'), '{"mcpServers":{}}')
  writeFileSync(join(p, 'hooks.json'), '{}')
}

describe('enumeratePluginIngredients', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k]
    vi.resetModules()
    fakeHome = mkdtempSync(join(tmpdir(), 'bc-enumerate-plugin-'))
  })
  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true })
  })
  it('includes only ENABLED plugins, tagged by plugin name', async () => {
    const { enumeratePluginIngredients } = await import('./index')
    const { pluginsDir } = await import('./index')
    fullPlugin(pluginsDir('global', null), 'onpack')
    fullPlugin(pluginsDir('global', null), 'offpack')
    store.pluginsEnabled = ['global:onpack']
    const ing = enumeratePluginIngredients(null, { trusted: false })
    expect(ing.skillFolders.map((s) => s.pluginName)).toEqual(['onpack'])
    expect(ing.ruleFiles[0].pluginName).toBe('onpack')
    expect(ing.mcpConfigs[0].pluginName).toBe('onpack')
    expect(ing.hookFiles.map((h) => h.pluginName)).toEqual(['onpack'])
  })
  it('suppresses enabled PROJECT plugins when untrusted', async () => {
    const { enumeratePluginIngredients, pluginsDir } = await import('./index')
    const proj = mkdtempSync(join(tmpdir(), 'bc-proj-'))
    fullPlugin(pluginsDir('project', proj), 'ppack')
    store.pluginsEnabled = ['project:ppack']
    expect(enumeratePluginIngredients(proj, { trusted: false }).skillFolders).toEqual([])
    expect(enumeratePluginIngredients(proj, { trusted: false }).hookFiles).toEqual([])
    expect(enumeratePluginIngredients(proj, { trusted: true }).skillFolders.length).toBe(1)
    expect(enumeratePluginIngredients(proj, { trusted: true }).hookFiles.length).toBe(1)
  })
})
