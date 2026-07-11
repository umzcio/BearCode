import { describe, it, expect } from 'vitest'
import { buildSeatbeltProfile } from './seatbeltProfile'
import type { SandboxPolicy } from './types'

const base: SandboxPolicy = {
  writeRoots: ['/Users/z/proj', '/private/tmp'],
  readDenyPaths: ['/Users/z/.ssh', '/Users/z/Library/Application Support/BearCode/keys.json'],
  allowNetwork: false
}

describe('buildSeatbeltProfile', () => {
  it('starts with version + deny default', () => {
    const p = buildSeatbeltProfile(base)
    expect(p.startsWith('(version 1)')).toBe(true)
    expect(p).toContain('(deny default)')
  })

  it('allows process exec/fork and a broad file-read', () => {
    const p = buildSeatbeltProfile(base)
    expect(p).toContain('(allow process-exec*)')
    expect(p).toContain('(allow process-fork)')
    expect(p).toContain('(allow file-read*)')
  })

  it('denies each read-deny subpath AFTER the broad allow (last-match-wins)', () => {
    const p = buildSeatbeltProfile(base)
    const readAllowIdx = p.indexOf('(allow file-read*)')
    const sshDenyIdx = p.indexOf('(deny file-read* (subpath "/Users/z/.ssh"))')
    expect(sshDenyIdx).toBeGreaterThan(readAllowIdx)
    expect(p).toContain(
      '(deny file-read* (subpath "/Users/z/Library/Application Support/BearCode/keys.json"))'
    )
  })

  it('allows file-write* only under each write root', () => {
    const p = buildSeatbeltProfile(base)
    expect(p).toContain('(allow file-write* (subpath "/Users/z/proj"))')
    expect(p).toContain('(allow file-write* (subpath "/private/tmp"))')
  })

  it('denies network when allowNetwork is false', () => {
    expect(buildSeatbeltProfile(base)).toContain('(deny network*)')
    expect(buildSeatbeltProfile(base)).not.toContain('(allow network*)')
  })

  it('allows network when allowNetwork is true', () => {
    expect(buildSeatbeltProfile({ ...base, allowNetwork: true })).toContain('(allow network*)')
  })

  it('escapes double-quotes and backslashes in paths', () => {
    const p = buildSeatbeltProfile({ ...base, writeRoots: ['/tmp/a"b\\c'] })
    expect(p).toContain('(allow file-write* (subpath "/tmp/a\\"b\\\\c"))')
  })
})
