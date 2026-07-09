import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { git, gitAvailable, createWorktrees } from './manager'
import { commitWorktree, mergeToBase, writeResolved, completeMerge, abortMerge } from './merge'

let hasGit = false
beforeAll(async () => {
  hasGit = await gitAvailable()
})

async function makeRepo(dir: string): Promise<void> {
  await git(['init', '-b', 'main'], dir)
  await git(['config', 'user.email', 't@t'], dir)
  await git(['config', 'user.name', 'T'], dir)
  writeFileSync(join(dir, 'a.txt'), 'base\n')
  await git(['add', '.'], dir)
  await git(['commit', '-m', 'init'], dir)
}

describe('merge engine (real git)', () => {
  it('clean fast-forward merge', async () => {
    if (!hasGit) return
    const ud = mkdtempSync(join(tmpdir(), 'bc-ud-'))
    const proj = mkdtempSync(join(tmpdir(), 'bc-proj-'))
    await makeRepo(proj)
    const [w] = await createWorktrees(ud, 'c1', proj, 'feature')
    writeFileSync(join(w.worktreePath, 'b.txt'), 'new\n')
    await commitWorktree(w, 'add b')
    const r = await mergeToBase(w)
    expect(r.status).toBe('clean')
    expect(readFileSync(join(proj, 'b.txt'), 'utf8')).toBe('new\n')
  })

  it('detects a conflict, resolves it, completes the merge', async () => {
    if (!hasGit) return
    const ud = mkdtempSync(join(tmpdir(), 'bc-ud2-'))
    const proj = mkdtempSync(join(tmpdir(), 'bc-proj2-'))
    await makeRepo(proj)
    const [w] = await createWorktrees(ud, 'c2', proj, 'feature')
    // diverge base and worktree on the same line
    writeFileSync(join(proj, 'a.txt'), 'base-side\n')
    await git(['commit', '-am', 'base edit'], proj)
    writeFileSync(join(w.worktreePath, 'a.txt'), 'wt-side\n')
    await commitWorktree(w, 'wt edit')
    const r = await mergeToBase(w)
    expect(r.status).toBe('conflict')
    expect(r.conflictedFiles).toContain('a.txt')
    await writeResolved(w, 'a.txt', 'resolved\n')
    await completeMerge(w)
    expect(readFileSync(join(proj, 'a.txt'), 'utf8')).toBe('resolved\n')
  })

  it('abort restores the pre-merge base state', async () => {
    if (!hasGit) return
    const ud = mkdtempSync(join(tmpdir(), 'bc-ud3-'))
    const proj = mkdtempSync(join(tmpdir(), 'bc-proj3-'))
    await makeRepo(proj)
    const [w] = await createWorktrees(ud, 'c3', proj, 'feature')
    writeFileSync(join(proj, 'a.txt'), 'base-side\n')
    await git(['commit', '-am', 'base edit'], proj)
    writeFileSync(join(w.worktreePath, 'a.txt'), 'wt-side\n')
    await commitWorktree(w, 'wt edit')
    await mergeToBase(w)
    await abortMerge(w)
    expect(readFileSync(join(proj, 'a.txt'), 'utf8')).toBe('base-side\n')
  })
})
