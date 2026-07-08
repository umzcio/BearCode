import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  DiffFsBackend,
  jailPath,
  normalizeWorktreeMappings,
  worktreeWritePath,
  worktreeCommandCwd
} from './fsBackend'

describe('DiffFsBackend multi-root routing', () => {
  it('routes a repo-path write into its worktree, not the project', async () => {
    const proj = mkdtempSync(join(tmpdir(), 'bc-p-'))
    const wt = mkdtempSync(join(tmpdir(), 'bc-w-'))
    mkdirSync(join(proj, 'api'), { recursive: true })
    mkdirSync(join(wt, 'api'), { recursive: true })
    const be = new DiffFsBackend('c1', proj, 'g1', [
      { repoPath: join(proj, 'api'), worktreePath: wt }
    ])
    await be.write('api/server.ts', 'export const x = 1\n')
    expect(existsSync(join(wt, 'server.ts'))).toBe(true) // wt is repoPath's worktree root
    expect(existsSync(join(proj, 'api', 'server.ts'))).toBe(false)
  })

  it('writes a loose file (no repo) through to the project folder', async () => {
    const proj = mkdtempSync(join(tmpdir(), 'bc-p2-'))
    const wt = mkdtempSync(join(tmpdir(), 'bc-w2-'))
    mkdirSync(join(proj, 'api'), { recursive: true })
    const be = new DiffFsBackend('c1', proj, 'g1', [
      { repoPath: join(proj, 'api'), worktreePath: wt }
    ])
    await be.write('README.md', '# hi\n')
    expect(readFileSync(join(proj, 'README.md'), 'utf8')).toBe('# hi\n')
  })

  it('still hard-jails escapes to the project root', async () => {
    const proj = mkdtempSync(join(tmpdir(), 'bc-p3-'))
    const be = new DiffFsBackend('c1', proj, 'g1', [])
    const res = await be.write('../escape.ts', 'nope')
    expect(res.error).toBeTruthy()
    expect(existsSync(join(proj, '..', 'escape.ts'))).toBe(false)
  })
})

describe('worktree routing helpers (used by tools outside the backend)', () => {
  it('worktreeWritePath routes a repo path into its worktree', () => {
    const proj = mkdtempSync(join(tmpdir(), 'bc-hw-'))
    const wt = mkdtempSync(join(tmpdir(), 'bc-hwt-'))
    mkdirSync(join(proj, 'api'), { recursive: true })
    const wts = normalizeWorktreeMappings([{ repoPath: join(proj, 'api'), worktreePath: wt }])
    const abs = jailPath(proj, 'api/report.pdf')
    expect(worktreeWritePath(abs, wts)).toBe(join(realpathSync(wt), 'report.pdf'))
  })

  it('worktreeWritePath leaves a loose path at the project root', () => {
    const proj = mkdtempSync(join(tmpdir(), 'bc-hw2-'))
    const wt = mkdtempSync(join(tmpdir(), 'bc-hwt2-'))
    mkdirSync(join(proj, 'api'), { recursive: true })
    const wts = normalizeWorktreeMappings([{ repoPath: join(proj, 'api'), worktreePath: wt }])
    const abs = jailPath(proj, 'README.md')
    expect(worktreeWritePath(abs, wts)).toBe(join(realpathSync(proj), 'README.md'))
  })

  it('worktreeWritePath is identity for an empty table', () => {
    const proj = mkdtempSync(join(tmpdir(), 'bc-hw3-'))
    const abs = jailPath(proj, 'x.txt')
    expect(worktreeWritePath(abs, [])).toBe(abs)
  })

  it('worktreeCommandCwd points at the root repo worktree when the root is a repo', () => {
    const proj = mkdtempSync(join(tmpdir(), 'bc-cwd-'))
    const wt = mkdtempSync(join(tmpdir(), 'bc-cwdt-'))
    const wts = normalizeWorktreeMappings([{ repoPath: proj, worktreePath: wt }])
    expect(worktreeCommandCwd(proj, wts)).toBe(realpathSync(wt))
  })

  it('worktreeCommandCwd falls back to the project folder with no root worktree', () => {
    const proj = mkdtempSync(join(tmpdir(), 'bc-cwd2-'))
    const wt = mkdtempSync(join(tmpdir(), 'bc-cwdt2-'))
    mkdirSync(join(proj, 'api'), { recursive: true })
    // only a CHILD repo has a worktree; the project root itself is not routed
    const wts = normalizeWorktreeMappings([{ repoPath: join(proj, 'api'), worktreePath: wt }])
    expect(worktreeCommandCwd(proj, wts)).toBe(realpathSync(proj))
  })

  it('worktreeCommandCwd is the real project folder in local mode', () => {
    const proj = mkdtempSync(join(tmpdir(), 'bc-cwd3-'))
    expect(worktreeCommandCwd(proj, [])).toBe(realpathSync(proj))
  })
})
