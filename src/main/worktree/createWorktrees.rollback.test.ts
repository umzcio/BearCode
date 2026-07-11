import { describe, it, expect, vi, beforeEach } from 'vitest'

const git = vi.fn()
vi.mock('./git', () => ({
  git,
  gitAvailable: () => true,
  isGitRepo: () => true,
  discoverRepos: () => ['/repo/a', '/repo/b']
}))
vi.mock('./paths', () => ({
  slugify: (s: string) => s,
  worktreeBranchName: () => 'bearcode/work-1234',
  worktreePathFor: (_u: string, _c: string, name: string) => `/wt/${name}`
}))

describe('createWorktrees rollback', () => {
  beforeEach(() => {
    git.mockReset()
  })

  it('removes already-created worktrees when a later repo fails', async () => {
    // rev-parse (currentBranch) succeeds; first `worktree add` succeeds; second throws.
    git.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse') return { stdout: 'main' }
      if (args[0] === 'worktree' && args[1] === 'add' && args.includes('/wt/b')) {
        throw new Error('add failed on repo b')
      }
      return { stdout: '' }
    })
    const { createWorktrees } = await import('./manager')
    await expect(createWorktrees('/u', 'conv1', '/proj', 'work')).rejects.toThrow('add failed')

    // Rollback must have removed repo a's worktree and deleted its branch.
    const removeCalls = git.mock.calls.map((c) => c[0] as string[])
    expect(removeCalls).toContainEqual(
      expect.arrayContaining(['worktree', 'remove', '--force', '/wt/a'])
    )
    expect(removeCalls).toContainEqual(
      expect.arrayContaining(['branch', '-D', 'bearcode/work-1234'])
    )
  })
})
