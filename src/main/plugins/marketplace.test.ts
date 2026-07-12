import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
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
