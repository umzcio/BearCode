import { Suspense, lazy, useEffect, useState } from 'react'
import { applyChoice } from '@shared/conflict'
import { useAppStore } from '../../state/store'
import { IconClose, IconGitBranch } from '../icons'
import './ConflictResolver.css'

const MonacoEditable = lazy(() => import('../MonacoEditable'))

function basename(p: string): string {
  return p.replace(/\/$/, '').split('/').pop() || p
}

// F3: the Monaco conflict resolver. Driven entirely by `store.conflict`, which
// mergeWorktree seeds when a per-repo merge returns 'conflict'. It walks the
// conflicted files one at a time (`index`): each file is loaded from the base
// repo's working tree (marker-laden) via `readConflict`, edited in Monaco with
// Accept ours / Accept theirs shortcuts (the same pure `applyChoice` the merge
// engine uses), then written back + `git add`ed via `resolveFile`. Once every
// file is resolved the merge is committed via `completeMerge`; Abort restores
// the base repo at any point. Clearing `store.conflict` closes the modal.
export function ConflictResolver(): React.JSX.Element | null {
  const conflict = useAppStore((s) => s.conflict)
  const [text, setText] = useState('')
  // The pristine marker-laden text as loaded for the current file. Accept
  // ours/theirs always derive from this (not the live buffer) so the two are
  // toggleable — accepting ours doesn't strip the markers theirs would need.
  const [original, setOriginal] = useState('')
  const [busy, setBusy] = useState(false)

  const convId = conflict?.convId
  const repoPath = conflict?.repoPath
  const files = conflict?.files
  const index = conflict?.index ?? 0
  const file = files && index < files.length ? files[index] : undefined
  const done = !!files && index >= files.length

  // Load the current conflicted file into the editor whenever we advance to a
  // new file (or open the resolver). setState happens in the async callback,
  // never synchronously in the effect body.
  useEffect(() => {
    if (!convId || !repoPath || !file) return
    let live = true
    void window.bearcode.worktree.readConflict(convId, repoPath, file).then((r) => {
      if (live) {
        setText(r.merged)
        setOriginal(r.merged)
      }
    })
    return () => {
      live = false
    }
  }, [convId, repoPath, file])

  if (!conflict || !convId || !repoPath || !files) return null

  const clear = (): void => useAppStore.setState({ conflict: null } as never)

  const markResolved = async (): Promise<void> => {
    if (busy || !file) return
    setBusy(true)
    try {
      await window.bearcode.worktree.resolveFile(convId, repoPath, file, text)
      useAppStore.setState((s) =>
        s.conflict ? ({ conflict: { ...s.conflict, index: s.conflict.index + 1 } } as never) : {}
      )
    } finally {
      setBusy(false)
    }
  }

  const complete = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await window.bearcode.worktree.completeMerge(convId, repoPath)
      clear()
      useAppStore.getState().showToast('Merged to ' + basename(repoPath))
    } finally {
      setBusy(false)
    }
  }

  const abort = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await window.bearcode.worktree.abort(convId, repoPath)
      clear()
      useAppStore.getState().showToast('Merge aborted')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="modal-overlay open"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) void abort()
      }}
    >
      <div className="conflict-panel">
        <div className="conflict-head">
          <div className="conflict-title">
            <IconGitBranch />
            <span>Resolve conflicts — {basename(repoPath)}</span>
          </div>
          <button className="content-close" title="Abort merge" onClick={() => void abort()}>
            <IconClose />
          </button>
        </div>

        <div className="conflict-progress">
          {files.map((f, i) => (
            <span
              key={f}
              className={
                'conflict-chip' +
                (i < index ? ' resolved' : '') +
                (i === index && !done ? ' current' : '')
              }
              title={f}
            >
              {basename(f)}
            </span>
          ))}
        </div>

        {done ? (
          <div className="conflict-done">
            <p>All {files.length === 1 ? 'conflicts' : `${files.length} files`} resolved.</p>
            <p className="conflict-done-sub">Commit the merge to land it in the base repo.</p>
          </div>
        ) : (
          <>
            <div className="conflict-file">{file}</div>
            <div className="conflict-editor">
              <Suspense fallback={<div className="conflict-loading">Loading…</div>}>
                <MonacoEditable value={text} onChange={setText} />
              </Suspense>
            </div>
          </>
        )}

        <div className="conflict-actions">
          {!done ? (
            <>
              <button
                className="pill-btn"
                onClick={() => setText(applyChoice(original, 'ours'))}
                disabled={busy}
              >
                Accept ours
              </button>
              <button
                className="pill-btn"
                onClick={() => setText(applyChoice(original, 'theirs'))}
                disabled={busy}
              >
                Accept theirs
              </button>
              <span className="conflict-actions-spacer" />
              <button className="pill-btn" onClick={() => void abort()} disabled={busy}>
                Abort
              </button>
              <button
                className="pill-btn primary"
                onClick={() => void markResolved()}
                disabled={busy}
              >
                Mark resolved
              </button>
            </>
          ) : (
            <>
              <button className="pill-btn" onClick={() => void abort()} disabled={busy}>
                Abort
              </button>
              <span className="conflict-actions-spacer" />
              <button className="pill-btn primary" onClick={() => void complete()} disabled={busy}>
                Complete merge
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
