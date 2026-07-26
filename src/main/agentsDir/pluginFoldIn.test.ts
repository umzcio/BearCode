import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const store: Record<string, unknown> = {}
vi.mock('../settings', () => ({
  getSettings: () => ({ pluginsEnabled: (store.pluginsEnabled as string[]) ?? [] }),
  setSettings: (p: Record<string, unknown>) => Object.assign(store, p)
}))

let projectDir: string
let homeDir: string

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k]
  projectDir = mkdtempSync(join(tmpdir(), 'bc-plugin-foldin-proj-'))
  homeDir = mkdtempSync(join(tmpdir(), 'bc-plugin-foldin-home-'))
  vi.stubEnv('HOME', homeDir)
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(projectDir, { recursive: true, force: true })
  rmSync(homeDir, { recursive: true, force: true })
})

// End-to-end: after this plan lands, BOTH the manifest-layer scan
// (plugins/manifest.ts + plugins/index.ts's scanScope, Steps 1-2) and this
// file's own fold-in read (Step 3) reject the symlink -- the manifest layer
// is actually the binding constraint for rules/skills (enumeratePluginIngredients
// derives ing.ruleFiles/ing.skillFolders from the manifest's already-validated
// p.rules/p.skills), so this test validates the end-to-end security property
// (no leak) rather than isolating Step 3's check specifically. That's fine:
// the observable behavior that matters is "the secret never reaches the
// prompt," and Step 3's own root check remains valuable defense-in-depth
// against a future change to enumeratePluginIngredients.
describe('loadAgentsContent plugin fold-in symlink containment', () => {
  it('excludes a project-scope plugin rule whose file symlinks outside the project', async () => {
    const { loadAgentsContent } = await import('./index')
    const { pluginsDir } = await import('../plugins')
    const outsideDir = mkdtempSync(join(tmpdir(), 'bc-plugin-foldin-outside-'))
    try {
      const dir = join(pluginsDir('project', projectDir), 'sneaky')
      mkdirSync(join(dir, 'rules'), { recursive: true })
      writeFileSync(join(dir, 'plugin.json'), '{}')
      writeFileSync(
        join(outsideDir, 'secret.md'),
        '---\nactivation: always\ndescription: leak\n---\nSECRET PLUGIN RULE CONTENT'
      )
      symlinkSync(join(outsideDir, 'secret.md'), join(dir, 'rules', 'style.md'))
      store.pluginsEnabled = ['project:sneaky']

      const content = loadAgentsContent(projectDir, { trusted: true })

      expect(content.rules.some((r) => r.body.includes('SECRET PLUGIN RULE CONTENT'))).toBe(false)
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('excludes a project-scope plugin SKILL.md whose leaf symlinks outside the project', async () => {
    const { loadAgentsContent } = await import('./index')
    const { pluginsDir } = await import('../plugins')
    const outsideDir = mkdtempSync(join(tmpdir(), 'bc-plugin-foldin-outside-'))
    try {
      const dir = join(pluginsDir('project', projectDir), 'sneaky2')
      const skillDir = join(dir, 'skills', 'evil')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(dir, 'plugin.json'), '{}')
      writeFileSync(
        join(outsideDir, 'SKILL.md'),
        '---\nname: evil\ndescription: leak\n---\nSECRET PLUGIN SKILL CONTENT'
      )
      symlinkSync(join(outsideDir, 'SKILL.md'), join(skillDir, 'SKILL.md'))
      store.pluginsEnabled = ['project:sneaky2']

      const content = loadAgentsContent(projectDir, { trusted: true })

      expect(content.skills.some((s) => s.body.includes('SECRET PLUGIN SKILL CONTENT'))).toBe(
        false
      )
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })
})
