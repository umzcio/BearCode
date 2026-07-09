import { useState } from 'react'
import { useAppStore } from '../../state/store'
import { IconGitBranch } from '../icons'
import './WorktreeBar.css'

function basename(p: string): string {
  return p.replace(/\/$/, '').split('/').pop() || p
}

// F3: the per-conversation Worktree action bar. Shown only for a worktree
// conversation that actually has spawned worktrees (a non-git folder degrades
// to local, so this stays hidden for local conversations). Lists each repo's
// branch with a per-repo "Merge to main" button (multi-repo merges are
// independent), plus one "Discard worktree" button that tears the whole
// conversation's worktrees down. A conflicting merge opens the Monaco resolver
// via the store's `conflict` slice (Task 12).
export function WorktreeBar({ convoId }: { convoId: string }): React.JSX.Element | null {
  const convo = useAppStore((s) => s.conversations[convoId])
  const mergeWorktree = useAppStore((s) => s.mergeWorktree)
  const discardWorktree = useAppStore((s) => s.discardWorktree)
  // Per-repo in-flight guard: a double-click on one repo's Merge would launch a
  // second concurrent merge in the same base repo (index.lock failure), so the
  // button is disabled until its merge settles. Discard is disabled while any
  // merge is in flight (and vice-versa) to keep the base repo consistent.
  const [merging, setMerging] = useState<Record<string, boolean>>({})
  const [discarding, setDiscarding] = useState(false)

  if (!convo || convo.environment !== 'worktree' || convo.worktrees.length === 0) return null

  const multi = convo.worktrees.length > 1
  const anyMerging = Object.values(merging).some(Boolean)

  const onMerge = async (repoPath: string): Promise<void> => {
    if (merging[repoPath] || discarding) return
    setMerging((m) => ({ ...m, [repoPath]: true }))
    try {
      await mergeWorktree(convoId, repoPath)
    } finally {
      setMerging((m) => ({ ...m, [repoPath]: false }))
    }
  }

  const onDiscard = async (): Promise<void> => {
    if (discarding || anyMerging) return
    if (!window.confirm('Discard this conversation’s worktrees? Unmerged changes are lost.')) return
    setDiscarding(true)
    try {
      await discardWorktree(convoId)
    } finally {
      setDiscarding(false)
    }
  }

  return (
    <div className="worktree-bar">
      <div className="worktree-repos">
        {convo.worktrees.map((w) => (
          <div className="worktree-repo" key={w.repoPath}>
            <span className="worktree-branch" title={`${w.branch} → ${w.baseBranch}`}>
              <IconGitBranch />
              {multi ? <span className="worktree-repo-name">{basename(w.repoPath)}</span> : null}
              <span className="worktree-branch-name">{w.branch}</span>
            </span>
            <button
              className="pill-btn worktree-merge"
              onClick={() => void onMerge(w.repoPath)}
              disabled={!!merging[w.repoPath] || discarding}
            >
              Merge to main
            </button>
          </div>
        ))}
      </div>
      <button
        className="pill-btn worktree-discard"
        onClick={() => void onDiscard()}
        disabled={discarding || anyMerging}
      >
        Discard worktree
      </button>
    </div>
  )
}
