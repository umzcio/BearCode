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

  if (!convo || convo.environment !== 'worktree' || convo.worktrees.length === 0) return null

  const multi = convo.worktrees.length > 1

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
              onClick={() => void mergeWorktree(convoId, w.repoPath)}
            >
              Merge to main
            </button>
          </div>
        ))}
      </div>
      <button
        className="pill-btn worktree-discard"
        onClick={() => {
          if (window.confirm('Discard this conversation’s worktrees? Unmerged changes are lost.'))
            void discardWorktree(convoId)
        }}
      >
        Discard worktree
      </button>
    </div>
  )
}
