import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const store: Record<string, unknown> = {}
vi.mock('../settings', () => ({
  getSettings: () => ({ pluginsEnabled: (store.pluginsEnabled as string[]) ?? [] }),
  setSettings: (p: Record<string, unknown>) => Object.assign(store, p)
}))

function plugin(root: string, name: string): void {
  const p = join(root, name)
  mkdirSync(p, { recursive: true })
  writeFileSync(join(p, 'plugin.json'), JSON.stringify({ description: name }))
}

describe('plugin discovery + state', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k]
    vi.resetModules()
  })

  it('lists project plugins only when trusted', async () => {
    const { listPlugins } = await import('./index')
    const proj = mkdtempSync(join(tmpdir(), 'bc-proj-'))
    plugin(join(proj, '.agents', 'plugins'), 'projpack')
    expect(listPlugins(proj, { trusted: false }).some((e) => e.name === 'projpack')).toBe(false)
    expect(listPlugins(proj, { trusted: true }).some((e) => e.name === 'projpack')).toBe(true)
  })

  it('discovery rejects a symlinked rules directory inside a project plugin', async () => {
    const { listPlugins, pluginsDir } = await import('./index')
    const proj = mkdtempSync(join(tmpdir(), 'bc-proj-'))
    const outside = mkdtempSync(join(tmpdir(), 'bc-outside-'))
    try {
      const dir = join(pluginsDir('project', proj), 'sneaky')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'plugin.json'), '{}')
      writeFileSync(
        join(outside, 'secret.md'),
        '---\nactivation: always\ndescription: leak\n---\nSECRET'
      )
      symlinkSync(outside, join(dir, 'rules'))

      const entries = listPlugins(proj, { trusted: true })
      const sneaky = entries.find((e) => e.dirName === 'sneaky')

      expect(sneaky?.rules).toEqual([])
    } finally {
      rmSync(proj, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('discovery rejects a symlinked .agents/plugins directory itself', async () => {
    const { listPlugins } = await import('./index')
    const proj = mkdtempSync(join(tmpdir(), 'bc-proj-'))
    const outside = mkdtempSync(join(tmpdir(), 'bc-outside-'))
    try {
      plugin(outside, 'leaked')
      mkdirSync(join(proj, '.agents'), { recursive: true })
      symlinkSync(outside, join(proj, '.agents', 'plugins'))

      // Scope the assertion to project-sourced entries only -- this machine's
      // real global plugins dir (~/.bearcode/agents/plugins, not stubbed in
      // this test file) may already contain unrelated installed plugins.
      const projectEntries = listPlugins(proj, { trusted: true }).filter((e) =>
        e.source?.startsWith('project:')
      )
      expect(projectEntries).toEqual([])
    } finally {
      rmSync(proj, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('plugins default to disabled; setPluginEnabled flips them', async () => {
    const { isPluginEnabled, setPluginEnabled } = await import('./state')
    expect(isPluginEnabled('global', 'foo')).toBe(false)
    setPluginEnabled('global', 'foo', true)
    expect(store.pluginsEnabled).toEqual(['global:foo'])
    expect(isPluginEnabled('global', 'foo')).toBe(true)
    setPluginEnabled('global', 'foo', false)
    expect(store.pluginsEnabled).toEqual([])
  })

  it('uninstall removes the jailed dir and rejects traversal', async () => {
    const { uninstallPlugin, pluginsDir } = await import('./index')
    const proj = mkdtempSync(join(tmpdir(), 'bc-proj-'))
    plugin(pluginsDir('project', proj), 'gone')
    uninstallPlugin('project', 'gone', proj)
    expect(existsSync(join(pluginsDir('project', proj), 'gone'))).toBe(false)
    expect(() => uninstallPlugin('project', '../evil', proj)).toThrow(/traversal|kebab/i)
  })

  it('keys identity off the real directory name, not the manifest-declared name', async () => {
    const { listPlugins, uninstallPlugin, pluginsDir } = await import('./index')
    const proj = mkdtempSync(join(tmpdir(), 'bc-proj-'))
    const dir = pluginsDir('project', proj)
    // Two folders on disk: `a` is honest; `b`'s plugin.json falsely claims
    // its display name is also "a".
    plugin(dir, 'a')
    mkdirSync(join(dir, 'b'), { recursive: true })
    writeFileSync(join(dir, 'b', 'plugin.json'), JSON.stringify({ name: 'a', description: 'b' }))

    const entries = listPlugins(proj, { trusted: true })
    const a = entries.find((e) => e.dirName === 'a')
    const b = entries.find((e) => e.dirName === 'b')
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(b?.name).toBe('a') // display label can still collide
    expect(a?.source).not.toBe(b?.source) // but identity (source/dirName) must not

    // Uninstalling literal dir `a` must not affect `b`, even though `b`
    // displays as "a" too.
    uninstallPlugin('project', 'a', proj)
    expect(existsSync(join(dir, 'a'))).toBe(false)
    expect(existsSync(join(dir, 'b'))).toBe(true)
    const after = listPlugins(proj, { trusted: true })
    expect(after.some((e) => e.dirName === 'a')).toBe(false)
    expect(after.some((e) => e.dirName === 'b')).toBe(true)
  })

  it('uninstall scrubs enabled-state so a reinstalled plugin starts disabled', async () => {
    const { uninstallPlugin, pluginsDir } = await import('./index')
    const { setPluginEnabled, isPluginEnabled } = await import('./state')
    const proj = mkdtempSync(join(tmpdir(), 'bc-proj-'))
    plugin(pluginsDir('project', proj), 'reinstalled')

    setPluginEnabled('project', 'reinstalled', true)
    expect(isPluginEnabled('project', 'reinstalled')).toBe(true)

    uninstallPlugin('project', 'reinstalled', proj)
    expect(isPluginEnabled('project', 'reinstalled')).toBe(false)

    // A later install reusing the same name must not inherit the old
    // enabled state.
    plugin(pluginsDir('project', proj), 'reinstalled')
    expect(isPluginEnabled('project', 'reinstalled')).toBe(false)
  })
})

describe('jailedPluginFolder symlink escape (project scope)', () => {
  it('uninstallPlugin rejects when .agents/plugins is a symlink to outside the project', async () => {
    const { uninstallPlugin } = await import('./index')
    const proj = mkdtempSync(join(tmpdir(), 'bc-proj-'))
    const outside = mkdtempSync(join(tmpdir(), 'bc-outside-'))
    try {
      mkdirSync(join(outside, 'victim'), { recursive: true })
      writeFileSync(join(outside, 'victim', 'canary.txt'), 'do not delete me')
      mkdirSync(join(proj, '.agents'), { recursive: true })
      symlinkSync(outside, join(proj, '.agents', 'plugins'))
      expect(() => uninstallPlugin('project', 'victim', proj)).toThrow()
      expect(existsSync(join(outside, 'victim', 'canary.txt'))).toBe(true)
    } finally {
      rmSync(proj, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
