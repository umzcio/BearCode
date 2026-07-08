import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  git,
  gitAvailable,
  isGitRepo,
  discoverRepos,
  createWorktrees,
  removeWorktrees
} from './manager'

let hasGit = false
beforeAll(async () => {
  hasGit = await gitAvailable()
})

async function makeRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true })
  await git(['init', '-b', 'main'], dir)
  await git(['config', 'user.email', 't@t'], dir)
  await git(['config', 'user.name', 'T'], dir)
  writeFileSync(join(dir, 'a.txt'), 'hello\n')
  await git(['add', '.'], dir)
  await git(['commit', '-m', 'init'], dir)
}

describe('worktree manager (real git)', () => {
  it('discovers root + immediate child repos, not deep ones', async () => {
    if (!hasGit) return
    const proj = mkdtempSync(join(tmpdir(), 'bc-disc-'))
    await makeRepo(proj)
    await makeRepo(join(proj, 'api'))
    await makeRepo(join(proj, 'deep', 'nested'))
    const repos = discoverRepos(proj)
    expect(repos).toContain(proj)
    expect(repos).toContain(join(proj, 'api'))
    expect(repos).not.toContain(join(proj, 'deep', 'nested'))
  })

  it('creates a worktree per repo and removes it + its branch', async () => {
    if (!hasGit) return
    const userData = mkdtempSync(join(tmpdir(), 'bc-ud-'))
    const proj = mkdtempSync(join(tmpdir(), 'bc-proj-'))
    await makeRepo(proj)
    const wts = await createWorktrees(userData, 'conv1', proj, 'fix-login')
    expect(wts).toHaveLength(1)
    expect(existsSync(join(wts[0].worktreePath, 'a.txt'))).toBe(true)
    expect(wts[0].branch).toBe('bearcode/fix-login')
    expect(wts[0].baseBranch).toBe('main')
    await removeWorktrees(wts)
    expect(existsSync(wts[0].worktreePath)).toBe(false)
    const branches = (await git(['branch', '--list', 'bearcode/fix-login'], proj)).stdout
    expect(branches.trim()).toBe('')
  })

  it('falls back to no worktrees for a non-git folder', async () => {
    if (!hasGit) return
    const userData = mkdtempSync(join(tmpdir(), 'bc-ud2-'))
    const plain = mkdtempSync(join(tmpdir(), 'bc-plain-'))
    expect(isGitRepo(plain)).toBe(false)
    const wts = await createWorktrees(userData, 'conv2', plain, 'x')
    expect(wts).toEqual([])
  })
})
