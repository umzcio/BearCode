import { basename } from 'path'
import { rmSync } from 'fs'
import { git, gitAvailable, isGitRepo, discoverRepos } from './git'
import { slugify, worktreeBranchName, worktreePathFor } from './paths'

export { git, gitAvailable, isGitRepo, discoverRepos }

export interface WorktreeInfo {
  repoPath: string
  worktreePath: string
  branch: string
  baseBranch: string
}

async function currentBranch(repoPath: string): Promise<string> {
  const { stdout } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath)
  return stdout.trim() || 'HEAD'
}

// Per discovered repo: `git worktree add -b bearcode/<slug> <path> HEAD`. Repo
// names can collide across dirs (two `web/`); disambiguate the worktree folder
// name with an index suffix, never the branch (branch is per repo anyway).
export async function createWorktrees(
  userData: string,
  convId: string,
  projectPath: string,
  slug: string
): Promise<WorktreeInfo[]> {
  const repos = discoverRepos(projectPath)
  const branch = worktreeBranchName(slugify(slug))
  const out: WorktreeInfo[] = []
  const usedNames = new Map<string, number>()
  try {
    for (const repoPath of repos) {
      let name = basename(repoPath)
      const n = usedNames.get(name) ?? 0
      usedNames.set(name, n + 1)
      if (n > 0) name = `${name}-${n}`
      const worktreePath = worktreePathFor(userData, convId, name)
      const baseBranch = await currentBranch(repoPath)
      await git(['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], repoPath)
      out.push({ repoPath, worktreePath, branch, baseBranch })
    }
    return out
  } catch (e) {
    // Partial failure: tear down what we already created so no orphaned
    // worktrees/branches remain (they'd be undiscoverable — meta.worktrees is
    // never written on this path — and the deterministic branch name would make
    // every retry collide). removeWorktrees is best-effort per repo. (audit H-1)
    await removeWorktrees(out)
    throw e
  }
}

// Remove each worktree then delete its branch. Force-remove tolerates a dirty
// worktree (Discard already confirmed intent upstream). Best-effort per repo:
// one repo's failure does not abort the rest.
export async function removeWorktrees(worktrees: WorktreeInfo[]): Promise<void> {
  for (const w of worktrees) {
    try {
      await git(['worktree', 'remove', '--force', w.worktreePath], w.repoPath)
    } catch {
      try {
        rmSync(w.worktreePath, { recursive: true, force: true })
        await git(['worktree', 'prune'], w.repoPath)
      } catch {
        // leave stale registration; nothing else to do
      }
    }
    try {
      await git(['branch', '-D', w.branch], w.repoPath)
    } catch {
      // branch may be gone / checked out elsewhere
    }
  }
}
