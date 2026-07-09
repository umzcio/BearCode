import { readFileSync, writeFileSync } from 'fs'
import { git } from './git'
import { jailPath } from '../orchestrator/fsBackend'
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

// True when the base repo has a merge in progress (MERGE_HEAD present). `git
// rev-parse --verify` exits non-zero (rejecting) when the ref is absent.
async function isMergeInProgress(repoPath: string): Promise<boolean> {
  try {
    await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], repoPath)
    return true
  } catch {
    return false
  }
}

async function conflictedFilesIn(repoPath: string): Promise<string[]> {
  const out = (await git(['diff', '--name-only', '--diff-filter=U'], repoPath)).stdout
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

export async function mergeToBase(
  w: WorktreeInfo
): Promise<{ status: 'clean' | 'conflict'; conflictedFiles: string[] }> {
  // Recovery: a merge already in progress in the base repo (e.g. the app was
  // quit or reloaded mid-resolution) leaves MERGE_HEAD + a conflicted index.
  // Re-seed the resolver from the still-conflicted files instead of starting a
  // fresh merge — a `git checkout` here throws "resolve your current index
  // first" and would strand the repo with no in-app way out.
  if (await isMergeInProgress(w.repoPath)) {
    return { status: 'conflict', conflictedFiles: await conflictedFilesIn(w.repoPath) }
  }
  await git(['checkout', w.baseBranch], w.repoPath)
  try {
    await git(['merge', '--no-edit', w.branch], w.repoPath)
    return { status: 'clean', conflictedFiles: [] }
  } catch {
    const conflictedFiles = await conflictedFilesIn(w.repoPath)
    if (conflictedFiles.length === 0) throw new Error('Merge failed with no reported conflicts')
    return { status: 'conflict', conflictedFiles }
  }
}

export async function readConflict(w: WorktreeInfo, file: string): Promise<{ merged: string }> {
  // SECURITY: `file` is renderer-supplied (the conflicted path from the resolver);
  // jail it to the repo root so a crafted `../` can never read outside the repo.
  return { merged: readFileSync(jailPath(w.repoPath, file), 'utf8') }
}

export async function writeResolved(w: WorktreeInfo, file: string, content: string): Promise<void> {
  // SECURITY: jail the renderer-supplied path to the repo root before writing +
  // staging (no `../` escape) — matches the writes-always-jailed guard elsewhere.
  const abs = jailPath(w.repoPath, file)
  writeFileSync(abs, content)
  // `abs` is the jailed absolute path inside the repo; git add accepts it with
  // cwd at the repo root (no fragile relative() against a realpath'd root).
  await git(['add', abs], w.repoPath)
}

export async function completeMerge(w: WorktreeInfo): Promise<void> {
  await git(['commit', '--no-edit'], w.repoPath)
}

export async function abortMerge(w: WorktreeInfo): Promise<void> {
  await git(['merge', '--abort'], w.repoPath)
}
