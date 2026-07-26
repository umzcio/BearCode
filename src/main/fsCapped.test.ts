import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readFileCapped, isPathWithinRoot } from './fsCapped'

describe('readFileCapped', () => {
  let dir: string
  let outsideDir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bearcode-fscapped-'))
    outsideDir = mkdtempSync(join(tmpdir(), 'bearcode-fscapped-outside-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  })

  it('returns the file content for a normal regular file', () => {
    const filePath = join(dir, 'CLAUDE.md')
    writeFileSync(filePath, 'hello world')
    expect(readFileCapped(filePath, 1024)).toEqual({ text: 'hello world', truncated: false })
  })

  it('returns null for a symlinked leaf pointing outside the project, given a root', () => {
    const outsideFile = join(outsideDir, 'id_rsa')
    writeFileSync(outsideFile, 'super secret content')
    const linkPath = join(dir, 'CLAUDE.md')
    symlinkSync(outsideFile, linkPath)
    expect(readFileCapped(linkPath, 1024, dir)).toBeNull()
  })

  // Backward-compat: the leaf-symlink rejection is opt-in, gated on `root`
  // just like isPathWithinRoot below -- callers that never pass `root` (the
  // ~12 non-config-import call sites: agentsDir/index.ts, agentsDir/memory.ts,
  // hooks/loader.ts, plugins/manifest.ts, plugins/marketplace.ts) must keep
  // following symlinks exactly as they did before the config-import fix, e.g.
  // a dotfiles-managed symlinked ~/.bearcode/agents/rules/foo.md.
  it('with no root supplied, still follows a symlinked leaf (backward-compat, opt-in root)', () => {
    const outsideFile = join(outsideDir, 'id_rsa')
    writeFileSync(outsideFile, 'not actually secret in this context')
    const linkPath = join(dir, 'CLAUDE.md')
    symlinkSync(outsideFile, linkPath)
    expect(readFileCapped(linkPath, 1024)).toEqual({
      text: 'not actually secret in this context',
      truncated: false
    })
  })

  it('returns null for a dangling symlink without throwing, given a root', () => {
    const linkPath = join(dir, 'CLAUDE.md')
    symlinkSync(join(outsideDir, 'does-not-exist'), linkPath)
    expect(() => readFileCapped(linkPath, 1024, dir)).not.toThrow()
    expect(readFileCapped(linkPath, 1024, dir)).toBeNull()
  })

  it('returns null for a dangling symlink without throwing, with no root supplied', () => {
    // statSync on a dangling symlink still fails regardless of the leaf
    // symlink check, so this stays null either way -- just via a different
    // code path (the stats.isFile() / try-catch below, not the leaf check).
    const linkPath = join(dir, 'CLAUDE.md')
    symlinkSync(join(outsideDir, 'does-not-exist'), linkPath)
    expect(() => readFileCapped(linkPath, 1024)).not.toThrow()
    expect(readFileCapped(linkPath, 1024)).toBeNull()
  })

  it('still returns null for a non-regular file (directory)', () => {
    expect(readFileCapped(dir, 1024)).toBeNull()
  })

  // Security: an intermediate directory (not the leaf file) being a symlink
  // to outside `root` must be caught too -- readdirSync/lstatSync on the
  // leaf both transparently follow such a symlink, so the leaf itself is a
  // perfectly ordinary regular file and only a realpath-based containment
  // check (via the `root` param) sees the escape.
  it('returns null when an intermediate directory symlinks outside root, given a root', () => {
    const realOutsideDir = join(outsideDir, 'rules')
    mkdirSync(realOutsideDir)
    const leafFile = join(realOutsideDir, 'evil.md')
    writeFileSync(leafFile, 'evil content')
    const symlinkedDir = join(dir, '.cursor')
    symlinkSync(realOutsideDir, symlinkedDir)
    const candidatePath = join(symlinkedDir, 'evil.md')
    expect(readFileCapped(candidatePath, 1024, dir)).toBeNull()
  })

  it('still reads a file under a normal (non-symlinked) intermediate directory, given a root', () => {
    const subdir = join(dir, '.cursor')
    mkdirSync(subdir)
    const filePath = join(subdir, 'real.md')
    writeFileSync(filePath, 'real content')
    expect(readFileCapped(filePath, 1024, dir)).toEqual({ text: 'real content', truncated: false })
  })

  it('with no root supplied, still allows a normal file under a symlinked intermediate directory (backward-compat, opt-in root)', () => {
    // Documents that the `root` param is opt-in: callers that never pass it
    // (e.g. non-config-import readFileCapped call sites) keep the pre-fix
    // leaf-only behavior. This is intentional -- only config-import-scan
    // call sites are in scope for the intermediate-symlink guard.
    const realOutsideDir = join(outsideDir, 'rules2')
    mkdirSync(realOutsideDir)
    const leafFile = join(realOutsideDir, 'evil.md')
    writeFileSync(leafFile, 'evil content')
    const symlinkedDir = join(dir, '.cursor2')
    symlinkSync(realOutsideDir, symlinkedDir)
    const candidatePath = join(symlinkedDir, 'evil.md')
    expect(readFileCapped(candidatePath, 1024)).toEqual({ text: 'evil content', truncated: false })
  })
})

describe('isPathWithinRoot', () => {
  let dir: string
  let outsideDir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bearcode-fscapped-root-'))
    outsideDir = mkdtempSync(join(tmpdir(), 'bearcode-fscapped-root-outside-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  })

  it('returns true for a normal path inside root', () => {
    const filePath = join(dir, 'a', 'b.md')
    mkdirSync(join(dir, 'a'))
    writeFileSync(filePath, 'x')
    expect(isPathWithinRoot(filePath, dir)).toBe(true)
  })

  it('returns false when an intermediate directory symlinks outside root', () => {
    const realOutsideDir = join(outsideDir, 'sub')
    mkdirSync(realOutsideDir)
    writeFileSync(join(realOutsideDir, 'f.md'), 'x')
    symlinkSync(realOutsideDir, join(dir, 'linked'))
    expect(isPathWithinRoot(join(dir, 'linked', 'f.md'), dir)).toBe(false)
  })

  it('returns false (never throws) for a nonexistent path', () => {
    expect(() => isPathWithinRoot(join(dir, 'nope', 'f.md'), dir)).not.toThrow()
    expect(isPathWithinRoot(join(dir, 'nope', 'f.md'), dir)).toBe(false)
  })
})
