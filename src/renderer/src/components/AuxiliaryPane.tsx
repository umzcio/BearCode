import { Suspense, lazy, useEffect, useState } from 'react'
import type { Event, FileDiff, FileDiffFile } from '@shared/types'
import { useAppStore } from '../state/store'
import { ArtifactPane } from './ArtifactPane'
import {
  IconChevronDown,
  IconClose,
  IconDots,
  IconFile,
  IconLines,
  IconOverview,
  IconPanel,
  IconSearch
} from './icons'
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

function dirName(path: string): string {
  const name = baseName(path)
  return path.slice(0, Math.max(0, path.length - name.length - 1))
}

interface ReviewComment {
  id: number
  path: string
  line: number
  text: string
}

export function ReviewPanel(): React.JSX.Element | null {
  const sel = useAppStore((s) => s.auxSelection)
  // One side-panel mount, two exclusive occupants until Task 4 unifies them.
  if (sel?.kind === 'artifact')
    return <ArtifactPane key={sel.artifactId} artifactId={sel.artifactId} />
  if (sel?.kind === 'diff') return <ReviewPanelInner key={sel.diffId} diffId={sel.diffId} />
  return null
}

function ReviewPanelInner({ diffId }: { diffId: string }): React.JSX.Element {
  const closeReview = useAppStore((s) => s.closeReview)
  const focusPath = useAppStore((s) => s.reviewFocusPath)
  const view = useAppStore((s) => s.view)
  const conversations = useAppStore((s) => s.conversations)
  const send = useAppStore((s) => s.send)
  const showToast = useAppStore((s) => s.showToast)
  const [diff, setDiff] = useState<FileDiff | null>(null)
  // 'overview' | 'review' | a file path (that file's full-code tab)
  const [tab, setTab] = useState<string>('review')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [comments, setComments] = useState<ReviewComment[]>([])

  const convoId = view.kind === 'conversation' ? view.id : null
  const convo = convoId ? conversations[convoId] : null

  // The user prompt this diff belongs to, for the For Turn chip.
  let turnPrompt = ''
  if (convo) {
    let sawDiff = false
    for (let i = convo.events.length - 1; i >= 0; i--) {
      const ev: Event = convo.events[i]
      if (ev.type === 'file_diff' && ev.diffId === diffId) sawDiff = true
      else if (sawDiff && ev.type === 'user_message') {
        turnPrompt = ev.text
        break
      }
    }
  }

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
  }

  const files = diff?.files ?? []
  const fileTab = files.find((f) => f.path === tab)

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

  // Functional update: Monaco captures this closure once at mount, so the
  // id derives from the previous list, never from render-time state.
  const addComment = (path: string) => (line: number, text: string) => {
    setComments((c) => [...c, { id: (c[c.length - 1]?.id ?? 0) + 1, path, line, text }])
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

  const soon = (): void => showToast('Coming soon')

  return (
    <div className="review-side">
      <div className="review-tabs">
        <button
          className={'review-tab' + (tab === 'overview' ? ' active' : '')}
          onClick={() => setTab('overview')}
        >
          <IconOverview />
          Overview
        </button>
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
            onClick={() => setTab(f.path)}
          >
            <span className="code-mark">{'</>'}</span>
            {baseName(f.path)}
          </button>
        ))}
        <button className="panel-close" title="Close panel" onClick={closeReview}>
          <IconPanel />
        </button>
      </div>

      {tab === 'overview' ? (
        <div className="review-scroll">
          <div className="overview-body">
            <div className="overview-title">Overview</div>
            {turnPrompt ? <div className="overview-prompt">{turnPrompt}</div> : null}
            <div className="overview-sub">
              {files.length} file{files.length === 1 ? '' : 's'} changed
            </div>
            {files.map((f) => (
              <button key={f.fileId} className="overview-file" onClick={() => setTab(f.path)}>
                <span className="code-mark">{'</>'}</span>
                <span className="fname">{baseName(f.path)}</span>
                <span className="fdir">{dirName(f.path)}</span>
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
        </div>
      ) : null}

      {tab === 'review' ? (
        <>
          <div className="review-head">
            <span className="review-head-title">Review</span>
            <span className="turn-chip">
              <span className="turn-chip-label">For Turn</span>
              <span className="turn-chip-text">{turnPrompt || 'This conversation'}</span>
              <button className="turn-chip-x" title="Close review" onClick={closeReview}>
                <IconClose size={12} />
              </button>
            </span>
            <span className="review-head-icons">
              <button className="head-icon" title="More actions" onClick={soon}>
                <IconDots />
              </button>
              <button className="head-icon" title="Search changes" onClick={soon}>
                <IconSearch />
              </button>
              <button className="head-icon" title="Comment: click a line number" onClick={soon}>
                <IconLines />
              </button>
            </span>
          </div>
          <div className="review-scroll">
            {files.map((f) => {
              const isCollapsed = collapsed[f.fileId] ?? false
              return (
                <div className="file-section" key={f.fileId}>
                  <div
                    className="file-section-head"
                    onClick={() => setCollapsed((c) => ({ ...c, [f.fileId]: !isCollapsed }))}
                  >
                    <span className="code-mark">{'</>'}</span>
                    <span className="fname">{baseName(f.path)}</span>
                    <span className="fdir">{dirName(f.path)}</span>
                    <span className="head-actions" onClick={(e) => e.stopPropagation()}>
                      {f.state === 'reverted' ? (
                        <span className="file-state reverted">Reverted</span>
                      ) : (
                        <>
                          <button
                            className="mini-btn"
                            onClick={() => void window.bearcode.diffs.open(f.fileId)}
                          >
                            Open
                          </button>
                          <button className="mini-btn" onClick={() => void revert(f)}>
                            Revert
                          </button>
                        </>
                      )}
                    </span>
                    <span className="stats">
                      <span className="plus">+{f.additions}</span>
                      <span className="minus">-{f.deletions}</span>
                    </span>
                    <span className={'chev' + (isCollapsed ? ' closed' : '')}>
                      <IconChevronDown />
                    </span>
                  </div>
                  {!isCollapsed ? (
                    <div className="file-section-body">
                      <Suspense fallback={<div className="diff-loading">Loading…</div>}>
                        {f.status === 'created' ? (
                          <MonacoCode
                            key={f.fileId}
                            value={f.afterText}
                            language={languageFor(f.path)}
                            commentedLines={commentedLines(f.path)}
                            onAddComment={addComment(f.path)}
                            fitContent
                            washAdded
                          />
                        ) : (
                          <MonacoDiff
                            key={f.fileId}
                            original={f.beforeText}
                            modified={f.afterText}
                            language={languageFor(f.path)}
                            commentedLines={commentedLines(f.path)}
                            onAddComment={addComment(f.path)}
                            fitContent
                          />
                        )}
                      </Suspense>
                    </div>
                  ) : null}
                </div>
              )
            })}
            {files.length === 0 ? <div className="diff-loading">Loading changes…</div> : null}
          </div>
        </>
      ) : null}

      {fileTab ? (
        <>
          <div className="review-crumb">
            {fileTab.path.split('/').map((part, i, arr) => (
              <span key={i} className="crumb-part">
                {i > 0 ? <span className="crumb-sep">›</span> : null}
                {i === arr.length - 1 ? <span className="code-mark">{'</>'}</span> : null}
                <span className={i === arr.length - 1 ? 'crumb-file' : ''}>{part}</span>
              </span>
            ))}
            <span className="review-head-icons">
              <button className="head-icon" title="More actions" onClick={soon}>
                <IconDots />
              </button>
              <button
                className="head-icon"
                title="Open file"
                onClick={() => void window.bearcode.diffs.open(fileTab.fileId)}
              >
                <IconFile />
              </button>
            </span>
          </div>
          <div className="review-code-body">
            <Suspense fallback={<div className="diff-loading">Loading…</div>}>
              <MonacoCode
                key={fileTab.fileId + ':code'}
                value={fileTab.afterText}
                language={languageFor(fileTab.path)}
                commentedLines={commentedLines(fileTab.path)}
                onAddComment={addComment(fileTab.path)}
              />
            </Suspense>
          </div>
        </>
      ) : null}

      {comments.length > 0 ? (
        <>
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
          <div className="comment-send">
            <button className="foot-btn accept" onClick={sendComments}>
              Send {comments.length === 1 ? '1 comment' : `${comments.length} comments`}
            </button>
          </div>
        </>
      ) : null}
    </div>
  )
}
