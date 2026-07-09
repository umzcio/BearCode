import { join, relative, isAbsolute, sep } from 'path'

export interface WorktreeMapping {
  repoPath: string
  worktreePath: string
}

export function slugify(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return s.length > 0 ? s : 'work'
}

export function worktreeBranchName(slug: string): string {
  return `bearcode/${slug}`
}

export function worktreePathFor(userData: string, convId: string, repoName: string): string {
  return join(userData, 'worktrees', convId, repoName)
}

// Longest-prefix match: the deepest repoPath that contains absPath wins, so a
// nested repo takes precedence over its parent. Boundary-safe: '/proj' must not
// match '/proj-other'. Returns null for loose files (under no repo).
export function matchWorktree(
  absPath: string,
  mappings: WorktreeMapping[]
): WorktreeMapping | null {
  let best: WorktreeMapping | null = null
  for (const m of mappings) {
    if (absPath === m.repoPath || absPath.startsWith(m.repoPath + sep)) {
      if (!best || m.repoPath.length > best.repoPath.length) best = m
    }
  }
  return best
}

// Absolute path of `absPath` inside its worktree. Caller guarantees a match.
export function toWorktreePath(absPath: string, m: WorktreeMapping): string {
  const rel = relative(m.repoPath, absPath)
  return isAbsolute(rel) ? absPath : join(m.worktreePath, rel)
}
