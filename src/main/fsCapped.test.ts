import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'fs'
import { execSync } from 'child_process'
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

  it('opens with O_NOFOLLOW when a root is supplied, and fstat-checks the descriptor (not the pathname)', () => {
    const filePath = join(dir, 'CLAUDE.md')
    writeFileSync(filePath, 'hello world')
    // No race constructible in a synchronous single-process test (see plan
    // 004's "Add new tests" step) -- this instead verifies readFileCapped
    // still reads correctly through the new open+fstat-on-descriptor path
    // when `root` gates it to O_NOFOLLOW, i.e. the mechanism itself is wired
    // up without breaking the ordinary (non-attack) case.
    expect(readFileCapped(filePath, 1024, dir)).toEqual({ text: 'hello world', truncated: false })
  })

  it('a symlink swapped onto the leaf AFTER an unrelated prior read is still rejected on the next call, given a root', () => {
    // Not a true single-call race (impossible to construct synchronously --
    // see plan 004), but confirms the check-then-open sequence is re-run
    // fully, and rejects correctly, on every call -- a stale "already
    // verified" assumption from a previous call is never carried forward.
    const realFile = join(dir, 'CLAUDE.md')
    writeFileSync(realFile, 'first read, legitimate')
    expect(readFileCapped(realFile, 1024, dir)).toEqual({
      text: 'first read, legitimate',
      truncated: false
    })
    rmSync(realFile)
    const outsideFile = join(outsideDir, 'swapped.md')
    writeFileSync(outsideFile, 'swapped in after the fact')
    symlinkSync(outsideFile, realFile)
    expect(readFileCapped(realFile, 1024, dir)).toBeNull()
  })

  // The exact O_RDONLY | O_NOFOLLOW flag value passed to openSync (gated on
  // `root`) is verified by code inspection (fsCapped.ts's readFileCapped),
  // not by a runtime spy: this codebase's fs imports are static ESM named
  // imports, and Vitest cannot spy on them ("Cannot redefine property:
  // openSync" / "Module namespace is not configurable in ESM") -- confirmed
  // by attempting `vi.spyOn(fs, 'openSync')` here, which throws rather than
  // intercepting the call.

  // Regression test (round3 whole-branch review): the O_NOFOLLOW hardening
  // above switched the isFile() check from a pre-open statSync(path) to a
  // post-open fstatSync(fd), which reintroduced a real hang risk -- opening a
  // FIFO with no writer via a bare O_RDONLY blocks the synchronous main
  // process INDEFINITELY. openSync must always include O_NONBLOCK (regardless
  // of whether `root` is passed) so the open itself returns immediately with
  // a "not ready" fd instead of blocking; the existing fstatSync(fd).isFile()
  // check then correctly rejects it as non-regular. This uses a REAL FIFO
  // (via the `mkfifo` binary -- Node's fs module has no direct mkfifo) with no
  // writer ever attached, so a regression here would hang this test (and the
  // whole `vitest run` process) rather than merely failing it -- that's the
  // exact failure mode this test exists to catch.
  it('returns null promptly (does not hang) for a FIFO with no writer', () => {
    const fifoPath = join(dir, 'a-fifo')
    execSync(`mkfifo "${fifoPath}"`)
    const start = Date.now()
    const result = readFileCapped(fifoPath, 1024)
    const elapsedMs = Date.now() - start
    expect(result).toBeNull()
    expect(elapsedMs).toBeLessThan(2000)
  })

  it('returns null promptly (does not hang) for a FIFO with no writer, given a root', () => {
    const fifoPath = join(dir, 'a-fifo-rooted')
    execSync(`mkfifo "${fifoPath}"`)
    const start = Date.now()
    const result = readFileCapped(fifoPath, 1024, dir)
    const elapsedMs = Date.now() - start
    expect(result).toBeNull()
    expect(elapsedMs).toBeLessThan(2000)
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
