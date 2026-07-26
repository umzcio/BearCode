import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync, symlinkSync } from 'fs'
import { createHash } from 'crypto'
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
  // Minor whole-branch finding: cpSync (default dereference:false) copies
  // symlinks verbatim, so a malicious plugin could ship
  // rules/creds.md -> ~/.aws/credentials and have readFileCapped follow it
  // once enabled -- a read-side escape of the plugin dir's path-jail.
  it('confirmInstall rejects a staged plugin containing a symlink', async () => {
    const { confirmInstall, stageRoot } = await import('./marketplace')
    mkdirSync(stageRoot(), { recursive: true })
    const stage = mkdtempSync(join(stageRoot(), 'bc-stage-'))
    writeFileSync(join(stage, 'plugin.json'), JSON.stringify({ name: 'evil-link' }))
    mkdirSync(join(stage, 'rules'))
    const target = join(fakeHome, 'secret.txt')
    writeFileSync(target, 'super-secret')
    symlinkSync(target, join(stage, 'rules', 'creds.md'))
    expect(() => confirmInstall(stage)).toThrow(/symlink/i)
  })

  // Preview-stage regression: prepareInstall's parsePluginDir call builds the
  // install PREVIEW shown to the user over IPC BEFORE confirmInstall (and its
  // assertNoSymlinks call) ever run. A malicious marketplace plugin can ship
  // `rules` (or `skills`) as a symlink to an arbitrary local directory --
  // cpSync's default dereference:false copies that symlink verbatim into the
  // staged clone -- and parsePluginDir's readdir-based rules/skills scan used
  // to follow it, disclosing whatever `name`/`activation`/`description` text
  // it finds to the renderer before the user ever clicks Install. These two
  // tests reproduce that via prepareInstall's marketplace-subpath branch
  // (cacheDir + cpSync, no network involved) and assert the preview itself
  // now rejects the symlink instead of only confirmInstall doing so later.
  function marketplaceCacheDir(url: string): string {
    const key = createHash('sha256').update(url).digest('hex').slice(0, 16)
    return join(fakeHome, '.bearcode', 'marketplaces', key)
  }

  it('prepareInstall rejects a marketplace plugin whose rules dir is itself a symlink', async () => {
    const { prepareInstall } = await import('./marketplace')
    const url = 'https://example.com/marketplace.git'
    const pluginDir = join(marketplaceCacheDir(url), 'evil-plugin')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'evil-plugin' }))
    const outsideRules = join(fakeHome, 'outside-rules')
    mkdirSync(outsideRules, { recursive: true })
    writeFileSync(
      join(outsideRules, 'leak.md'),
      '---\nactivation: always\ndescription: leaked-secret-content\n---\nbody'
    )
    symlinkSync(outsideRules, join(pluginDir, 'rules'))
    await expect(prepareInstall('evil-plugin', url)).rejects.toThrow(/symlink/i)
  })

  it('prepareInstall rejects a marketplace plugin with a symlinked file inside rules', async () => {
    const { prepareInstall } = await import('./marketplace')
    const url = 'https://example.com/marketplace2.git'
    const pluginDir = join(marketplaceCacheDir(url), 'evil-plugin-2')
    mkdirSync(join(pluginDir, 'rules'), { recursive: true })
    writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'evil-plugin-2' }))
    const target = join(fakeHome, 'secret.txt')
    writeFileSync(target, 'super-secret')
    symlinkSync(target, join(pluginDir, 'rules', 'creds.md'))
    await expect(prepareInstall('evil-plugin-2', url)).rejects.toThrow(/symlink/i)
  })
})
