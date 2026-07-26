import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { join } from 'path'
import { assertSafeGitUrl, normalizeGitSource } from './marketplace'

describe('normalizeGitSource', () => {
  it('passes bare repo URLs through as a .git clone URL, no subpath', () => {
    expect(normalizeGitSource('https://github.com/o/r')).toEqual({
      cloneUrl: 'https://github.com/o/r.git'
    })
    expect(normalizeGitSource('https://github.com/o/r.git')).toEqual({
      cloneUrl: 'https://github.com/o/r.git'
    })
  })
  it('parses a GitHub folder URL into cloneUrl + ref + subpath', () => {
    expect(normalizeGitSource('https://github.com/o/r/tree/main/plugins/foo')).toEqual({
      cloneUrl: 'https://github.com/o/r.git',
      ref: 'main',
      subpath: 'plugins/foo'
    })
  })
  it('parses a GitHub folder URL with a dotfile subpath and a branch', () => {
    expect(normalizeGitSource('https://github.com/o/r/tree/dev/.claude-plugin')).toEqual({
      cloneUrl: 'https://github.com/o/r.git',
      ref: 'dev',
      subpath: '.claude-plugin'
    })
  })
  it('handles gitlab tree and bitbucket src URLs', () => {
    expect(normalizeGitSource('https://gitlab.com/o/r/tree/main/p')).toEqual({
      cloneUrl: 'https://gitlab.com/o/r.git',
      ref: 'main',
      subpath: 'p'
    })
    expect(normalizeGitSource('https://bitbucket.org/o/r/src/main/p')).toEqual({
      cloneUrl: 'https://bitbucket.org/o/r.git',
      ref: 'main',
      subpath: 'p'
    })
  })
  it('leaves ssh/git@ URLs untouched', () => {
    expect(normalizeGitSource('git@github.com:o/r.git')).toEqual({ cloneUrl: 'git@github.com:o/r.git' })
  })
  it('rejects a non-URL string', () => {
    expect(() => normalizeGitSource('just some text')).toThrow()
  })
})

describe('assertSafeGitUrl', () => {
  it('accepts https and ssh/git@ URLs', () => {
    expect(() => assertSafeGitUrl('https://github.com/a/b')).not.toThrow()
    expect(() => assertSafeGitUrl('git@github.com:a/b.git')).not.toThrow()
    expect(() => assertSafeGitUrl('ssh://git@host/a/b')).not.toThrow()
  })
  it('rejects RCE-capable transports', () => {
    for (const bad of [
      'ext::sh -c whoami',
      'file:///etc',
      'fd::17',
      '-uarbitrary',
      'http://insecure'
    ])
      expect(() => assertSafeGitUrl(bad)).toThrow()
  })
})

// vi.mock calls are hoisted to the top of the module by vitest regardless of
// where they're written, so the `fakeHome`/`gitCalls` state they close over
// must live at module scope (not inside the describe callback) to avoid a
// dangling reference once hoisted.
const gitCalls: string[][] = []
let fakeHome: string
let fakeUserData: string

vi.mock('../worktree/git', () => ({
  git: async (args: string[]) => {
    gitCalls.push(args)
    return { stdout: '', stderr: '' }
  }
}))
vi.mock('os', async (orig) => {
  const actual = await orig<typeof import('os')>()
  return { ...actual, homedir: () => fakeHome }
})
// listCatalog reads settings (getSettings/setSettings, via ../settings) to
// pull the user-added marketplace list, and getSettings needs `electron`'s
// app.getPath for its settings.json location -- same mock shape as
// settings.plugins.test.ts. Only the listCatalog describe block below sets
// `fakeUserData`; every other test in this file never touches settings, so
// leaving it unset elsewhere is harmless.
vi.mock('electron', () => ({ app: { getPath: () => fakeUserData } }))

describe('updatePlugin', () => {
  beforeEach(() => {
    gitCalls.length = 0
    fakeHome = mkdtempSync(join(tmpdir(), 'bc-home-'))
  })
  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true })
  })

  it('pulls with hooks disabled so an update can never execute a plugin-planted git hook', async () => {
    vi.resetModules()
    const { updatePlugin } = await import('./marketplace')
    const { pluginsDir } = await import('./index')
    const dir = join(pluginsDir('global', null), 'some-plugin')
    mkdirSync(join(dir, '.git'), { recursive: true })
    await updatePlugin('some-plugin')
    expect(gitCalls).toHaveLength(1)
    expect(gitCalls[0]).toEqual(['-c', 'core.hooksPath=/dev/null', 'pull', '--ff-only'])
  })
})

describe('prepareInstall marketplace-catalog symlink containment', () => {
  beforeEach(() => {
    gitCalls.length = 0
    fakeHome = mkdtempSync(join(tmpdir(), 'bc-home-'))
  })
  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true })
  })

  it('refuses a subpath that resolves outside the marketplace clone via a symlinked intermediate directory', async () => {
    vi.resetModules()
    const { prepareInstall } = await import('./marketplace')
    const marketplaceUrl = 'https://example.com/evil-marketplace.git'
    const cacheHash = createHash('sha256').update(marketplaceUrl).digest('hex').slice(0, 16)
    const cacheDirPath = join(fakeHome, '.bearcode', 'marketplaces', cacheHash)
    const outsideDir = mkdtempSync(join(tmpdir(), 'bc-marketplace-outside-'))
    try {
      mkdirSync(cacheDirPath, { recursive: true })
      writeFileSync(join(outsideDir, 'plugin.json'), JSON.stringify({ description: 'leaked' }))
      writeFileSync(
        join(outsideDir, 'secret.txt'),
        'SECRET CONTENT THAT SHOULD NEVER BE COPIED'
      )
      // marketplace.json's `source` for this catalog entry is `escape` --
      // a directory the repo ships as a SYMLINK to outsideDir.
      symlinkSync(outsideDir, join(cacheDirPath, 'escape'))

      await expect(prepareInstall('escape', marketplaceUrl)).rejects.toThrow(/escapes the repo/i)
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('still allows a legitimate in-repo subpath after the containment fix (no regression)', async () => {
    vi.resetModules()
    const { prepareInstall } = await import('./marketplace')
    const marketplaceUrl = 'https://example.com/good-marketplace.git'
    const cacheHash = createHash('sha256').update(marketplaceUrl).digest('hex').slice(0, 16)
    const cacheDirPath = join(fakeHome, '.bearcode', 'marketplaces', cacheHash)
    mkdirSync(join(cacheDirPath, 'plugins', 'good-plugin'), { recursive: true })
    writeFileSync(
      join(cacheDirPath, 'plugins', 'good-plugin', 'plugin.json'),
      JSON.stringify({ description: 'A real plugin' })
    )

    const { manifest } = await prepareInstall('plugins/good-plugin', marketplaceUrl)

    expect(manifest.description).toBe('A real plugin')
  })
})

describe('listCatalog marketplace.json symlink containment', () => {
  beforeEach(() => {
    gitCalls.length = 0
    fakeHome = mkdtempSync(join(tmpdir(), 'bc-home-'))
    fakeUserData = mkdtempSync(join(tmpdir(), 'bc-userdata-'))
  })
  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true })
    rmSync(fakeUserData, { recursive: true, force: true })
  })

  it('excludes a marketplace whose marketplace.json is a symlink escaping the clone directory', async () => {
    vi.resetModules()
    const { listCatalog } = await import('./marketplace')
    const { setSettings } = await import('../settings')
    const marketplaceUrl = 'https://example.com/evil-marketplace-catalog.git'
    const cacheHash = createHash('sha256').update(marketplaceUrl).digest('hex').slice(0, 16)
    const cacheDirPath = join(fakeHome, '.bearcode', 'marketplaces', cacheHash)
    const outsideDir = mkdtempSync(join(tmpdir(), 'bc-catalog-outside-'))
    try {
      // The clone dir already exists (as it would after a real clone) so
      // listCatalog skips re-cloning and goes straight to reading
      // marketplace.json -- which the malicious repo ships as a symlink
      // pointing at a file OUTSIDE its own clone directory.
      mkdirSync(cacheDirPath, { recursive: true })
      writeFileSync(
        join(outsideDir, 'marketplace.json'),
        JSON.stringify({ plugins: [{ name: 'leaked-plugin', source: 'x' }] })
      )
      symlinkSync(join(outsideDir, 'marketplace.json'), join(cacheDirPath, 'marketplace.json'))
      setSettings({ marketplaces: [marketplaceUrl] })

      const catalog = await listCatalog()

      expect(catalog.some((p) => p.marketplaceUrl === marketplaceUrl)).toBe(false)
      expect(catalog.some((p) => p.name === 'leaked-plugin')).toBe(false)
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('still reads a legitimate marketplace.json after the containment fix (no regression)', async () => {
    vi.resetModules()
    const { listCatalog } = await import('./marketplace')
    const { setSettings } = await import('../settings')
    const marketplaceUrl = 'https://example.com/good-marketplace-catalog.git'
    const cacheHash = createHash('sha256').update(marketplaceUrl).digest('hex').slice(0, 16)
    const cacheDirPath = join(fakeHome, '.bearcode', 'marketplaces', cacheHash)
    mkdirSync(cacheDirPath, { recursive: true })
    writeFileSync(
      join(cacheDirPath, 'marketplace.json'),
      JSON.stringify({ plugins: [{ name: 'good-plugin', source: 'plugins/good-plugin' }] })
    )
    setSettings({ marketplaces: [marketplaceUrl] })

    const catalog = await listCatalog()

    expect(catalog.some((p) => p.marketplaceUrl === marketplaceUrl && p.name === 'good-plugin')).toBe(
      true
    )
  })
})

describe('cloneAndStage symlink containment (direct URL)', () => {
  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'bc-home-'))
  })
  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true })
  })

  it('refuses a subpath that resolves outside the cloned repo via a symlinked intermediate directory', async () => {
    vi.resetModules()
    const outsideDir = mkdtempSync(join(tmpdir(), 'bc-clone-outside-'))
    try {
      // Real `git clone` would populate the destination directory (the last
      // positional arg of the clone command) with the repo's tree, including
      // a symlink the malicious repo committed. Simulate exactly that ONE
      // side effect without touching real git or the network: the mocked
      // git(), when it sees a 'clone' command, creates a symlinked `evil`
      // directory inside `dest` pointing at outsideDir -- everything else
      // about safeClone (mkdirSync(dest) before this call) is real.
      vi.doMock('../worktree/git', () => ({
        git: async (args: string[]) => {
          const dest = args[args.length - 1]
          if (args.includes('clone')) {
            writeFileSync(join(outsideDir, 'secret.txt'), 'SECRET CLONE CONTENT')
            symlinkSync(outsideDir, join(dest, 'evil'))
          }
          return { stdout: '', stderr: '' }
        }
      }))
      const { prepareInstall } = await import('./marketplace')

      await expect(
        prepareInstall('https://github.com/attacker/evil-repo/tree/main/evil')
      ).rejects.toThrow(/escapes the repository/i)
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
      vi.doUnmock('../worktree/git')
    }
  })
})
