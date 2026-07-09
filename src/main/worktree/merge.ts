import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { git } from './git'
import type { WorktreeInfo } from '../../shared/types'

export async function commitWorktree(
  w: WorktreeInfo,
  message: string
): Promise<{ committed: boolean }> {
  await git(['add', '-A'], w.worktreePath)
  const status = (await git(['status', '--porcelain'], w.worktreePath)).stdout.trim()
  if (!status) return { committed: false }
  await git(['commit', '-m', message], w.worktreePath)
  return { committed: true }
}

export async function mergeToBase(
  w: WorktreeInfo
): Promise<{ status: 'clean' | 'conflict'; conflictedFiles: string[] }> {
  await git(['checkout', w.baseBranch], w.repoPath)
  try {
    await git(['merge', '--no-edit', w.branch], w.repoPath)
    return { status: 'clean', conflictedFiles: [] }
  } catch {
    const out = (await git(['diff', '--name-only', '--diff-filter=U'], w.repoPath)).stdout
    const conflictedFiles = out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    if (conflictedFiles.length === 0) throw new Error('Merge failed with no reported conflicts')
    return { status: 'conflict', conflictedFiles }
  }
}

export async function readConflict(w: WorktreeInfo, file: string): Promise<{ merged: string }> {
  return { merged: readFileSync(join(w.repoPath, file), 'utf8') }
}

export async function writeResolved(w: WorktreeInfo, file: string, content: string): Promise<void> {
  writeFileSync(join(w.repoPath, file), content)
  await git(['add', file], w.repoPath)
}

export async function completeMerge(w: WorktreeInfo): Promise<void> {
  await git(['commit', '--no-edit'], w.repoPath)
}

export async function abortMerge(w: WorktreeInfo): Promise<void> {
  await git(['merge', '--abort'], w.repoPath)
}
