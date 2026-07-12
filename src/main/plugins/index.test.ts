import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs'
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
})
