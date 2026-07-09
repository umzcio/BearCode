import { describe, it, expect } from 'vitest'
import { slugify, worktreeBranchName, worktreePathFor, matchWorktree } from './paths'

describe('slugify', () => {
  it('lowercases, hyphenates, strips junk, caps length', () => {
    expect(slugify('Fix the Login Bug!!')).toBe('fix-the-login-bug')
    expect(slugify('   ')).toBe('work')
    expect(slugify('a'.repeat(80)).length).toBeLessThanOrEqual(40)
  })
})

describe('worktreeBranchName', () => {
  it('prefixes bearcode/', () => {
    expect(worktreeBranchName('fix-login')).toBe('bearcode/fix-login')
  })
})

describe('worktreePathFor', () => {
  it('nests under userData/worktrees/<convId>/<repo>', () => {
    expect(worktreePathFor('/data', 'conv1', 'api')).toBe('/data/worktrees/conv1/api')
  })
})

describe('matchWorktree', () => {
  const m = [
    { repoPath: '/proj', worktreePath: '/wt/proj' },
    { repoPath: '/proj/api', worktreePath: '/wt/api' }
  ]
  it('returns the longest matching repoPath prefix', () => {
    expect(matchWorktree('/proj/api/server.ts', m)?.worktreePath).toBe('/wt/api')
    expect(matchWorktree('/proj/readme.md', m)?.worktreePath).toBe('/wt/proj')
  })
  it('returns null when no repo contains the path', () => {
    expect(matchWorktree('/elsewhere/x.ts', m)).toBeNull()
  })
  it('does not treat /proj-other as under /proj (boundary)', () => {
    expect(
      matchWorktree('/proj-other/x.ts', [{ repoPath: '/proj', worktreePath: '/wt' }])
    ).toBeNull()
  })
})
