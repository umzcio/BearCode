import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import type { FileDiff, FileDiffFile } from '@shared/types'
import { useAppStore } from '../state/store'
import { IconClose, IconFile } from './icons'
import './ReviewPanel.css'

const MonacoDiff = lazy(() => import('./MonacoDiff'))
const MonacoCode = lazy(() => import('./MonacoCode'))

const LANG_BY_EXT: Record<string, string> = {
  html: 'html',
  htm: 'html',
  css: 'css',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  md: 'markdown',
  py: 'python',
  sh: 'shell',
  zsh: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql',
  xml: 'xml'
}

function languageFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return LANG_BY_EXT[ext] ?? 'plaintext'
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path
}

interface ReviewComment {
  id: number
  path: string
  line: number
  text: string
}

export function ReviewPanel(): React.JSX.Element | null {
  const diffId = useAppStore((s) => s.reviewDiffId)
  if (!diffId) return null
  // Keyed on diffId so per-diff state starts fresh each time it opens.
  return <ReviewPanelInner key={diffId} diffId={diffId} />
}

function ReviewPanelInner({ diffId }: { diffId: string }): React.JSX.Element {
  const closeReview = useAppStore((s) => s.closeReview)
  const focusPath = useAppStore((s) => s.reviewFocusPath)
  const view = useAppStore((s) => s.view)
  const send = useAppStore((s) => s.send)
  const showToast = useAppStore((s) => s.showToast)
  const [diff, setDiff] = useState<FileDiff | null>(null)
  // 'review' shows the diff; a file path shows that file's full code.
  const [tab, setTab] = useState<string>('review')
  const [filePath, setFilePath] = useState<string | null>(null)
  const [comments, setComments] = useState<ReviewComment[]>([])
  // Ref, not state: Monaco captures the add-comment closure once at mount.
  const nextId = useRef(1)

  const convoId = view.kind === 'conversation' ? view.id : null

  useEffect(() => {
    let stale = false
    void window.bearcode.diffs.get(diffId).then((d) => {
      if (!stale) setDiff(d)
    })
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeReview()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      stale = true
      window.removeEventListener('keydown', onKey)
    }
  }, [diffId, closeReview])

  // A chip or step-row click focuses that file's code tab. Render-phase
  // state adjustment (not an effect) so it applies before paint.
  const [seenFocus, setSeenFocus] = useState<string | null>(null)
  if (focusPath && focusPath !== seenFocus) {
    setSeenFocus(focusPath)
    setTab(focusPath)
    setFilePath(focusPath)
  }

  const files = diff?.files ?? []
  const current: FileDiffFile | undefined =
    tab === 'review'
      ? (files.find((f) => f.path === filePath) ?? files[0])
      : (files.find((f) => f.path === tab) ?? files[0])

  const revert = async (file: FileDiffFile): Promise<void> => {
    await window.bearcode.diffs.revert(file.fileId)
    setDiff((d) =>
      d
        ? {
            ...d,
            files: d.files.map((f) => (f.fileId === file.fileId ? { ...f, state: 'reverted' } : f))
          }
        : d
    )
    showToast('Change reverted')
  }

  const addComment = (path: string) => (line: number, text: string) => {
    const id = nextId.current++
    setComments((c) => [...c, { id, path, line, text }])
  }

  const sendComments = (): void => {
    if (!convoId || comments.length === 0) return
    const lines = comments.map((c) => `- ${c.path} line ${c.line}: ${c.text}`)
    send(convoId, `Please address these review comments:\n${lines.join('\n')}`)
    setComments([])
    showToast(`Sent ${comments.length === 1 ? '1 comment' : `${comments.length} comments`}`)
    closeReview()
  }

  const commentedLines = (path: string): number[] =>
    comments.filter((c) => c.path === path).map((c) => c.line)

  const crumb = current ? current.path.split('/') : []

  return (
    <div className="review-side">
      <div className="review-tabs">
        <button
          className={'review-tab' + (tab === 'review' ? ' active' : '')}
          onClick={() => setTab('review')}
        >
          <IconFile />
          Review
        </button>
        {files.map((f) => (
          <button
            key={f.fileId}
            className={'review-tab' + (tab === f.path ? ' active' : '')}
            onClick={() => {
              setTab(f.path)
              setFilePath(f.path)
            }}
          >
            <span className="ftype">{'</>'}</span>
            {baseName(f.path)}
          </button>
        ))}
        <button className="close" title="Close" onClick={closeReview}>
          <IconClose />
        </button>
      </div>

      <div className="review-crumb">
        {crumb.map((part, i) => (
          <span key={i} className="crumb-part">
            {i > 0 ? <span className="crumb-sep">›</span> : null}
            <span className={i === crumb.length - 1 ? 'crumb-file' : ''}>{part}</span>
          </span>
        ))}
        {current ? (
          <span className="crumb-stats">
            <span className="plus">+{current.additions}</span>
            <span className="minus">-{current.deletions}</span>
          </span>
        ) : null}
      </div>

      {tab === 'review' && files.length > 1 ? (
        <div className="review-file-strip">
          {files.map((f) => (
            <button
              key={f.fileId}
              className={'strip-file' + (f.path === current?.path ? ' selected' : '')}
              onClick={() => setFilePath(f.path)}
            >
              <span className="fname">{baseName(f.path)}</span>
              {f.state === 'reverted' ? (
                <span className="file-state reverted">Reverted</span>
              ) : (
                <span className="stats">
                  <span className="plus">+{f.additions}</span>
                  <span className="minus">-{f.deletions}</span>
                </span>
              )}
            </button>
          ))}
        </div>
      ) : null}

      <div className="review-side-body">
        {current ? (
          <Suspense fallback={<div className="diff-loading">Loading…</div>}>
            {tab === 'review' ? (
              <MonacoDiff
                key={current.fileId}
                original={current.beforeText}
                modified={current.afterText}
                language={languageFor(current.path)}
                commentedLines={commentedLines(current.path)}
                onAddComment={addComment(current.path)}
              />
            ) : (
              <MonacoCode
                key={current.fileId + ':code'}
                value={current.afterText}
                language={languageFor(current.path)}
                commentedLines={commentedLines(current.path)}
                onAddComment={addComment(current.path)}
              />
            )}
          </Suspense>
        ) : (
          <div className="diff-loading">Loading changes…</div>
        )}
      </div>

      {comments.length > 0 ? (
        <div className="comment-list">
          {comments.map((c) => (
            <div className="comment-row" key={c.id}>
              <span className="comment-loc">
                {baseName(c.path)}:{c.line}
              </span>
              <span className="comment-text">{c.text}</span>
              <button
                className="comment-del"
                title="Remove comment"
                onClick={() => setComments((list) => list.filter((x) => x.id !== c.id))}
              >
                <IconClose size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="review-side-foot">
        <span className="foot-hint">Click a line number to comment</span>
        {current?.state === 'reverted' ? (
          <span className="file-state reverted">Reverted</span>
        ) : null}
        {current && current.state === 'applied' ? (
          <>
            <button className="foot-btn" onClick={() => void revert(current)}>
              Revert
            </button>
            <button
              className="foot-btn"
              onClick={() => void window.bearcode.diffs.open(current.fileId)}
            >
              Open
            </button>
          </>
        ) : null}
        {comments.length > 0 && convoId ? (
          <button className="foot-btn accept" onClick={sendComments}>
            Send {comments.length === 1 ? '1 comment' : `${comments.length} comments`}
          </button>
        ) : null}
      </div>
    </div>
  )
}
