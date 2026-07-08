import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DiffFsBackend } from './fsBackend'

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
