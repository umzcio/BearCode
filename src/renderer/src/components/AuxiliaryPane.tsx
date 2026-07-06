import { Suspense, lazy, useEffect, useState } from 'react'
import type { Event, FileDiff, FileDiffFile } from '@shared/types'
import { useAppStore, type AuxSelection } from '../state/store'
import { useCmdHeld } from '../lib/useCmdHeld'
import { ArtifactViewer } from './ArtifactViewer'
import { FilePreview } from './FilePreview/FilePreview'
import { deriveRailEntries, versionsOfType, type ArtifactEvent } from '../lib/auxRail'
import { ARTIFACT_STATUS_LABELS, ARTIFACT_TYPE_LABELS } from './events/ArtifactCard'
import {
  IconChevronDown,
  IconClose,
  IconDots,
  IconFile,
  IconLines,
  IconOverview,
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

// Renderer-side classification for the Preview/Diff default -- main isn't
// importable from the renderer, so this mirrors src/main/preview/classify.ts's
// rendered-preview extensions rather than importing it. Code files keep
// defaulting to the Diff/Monaco view -- they're already highlighted there;
// Preview is still reachable via the toggle for them.
const isBinaryPreview = (p: string): boolean =>
  /\.(png|jpe?g|gif|webp|bmp|svg|pdf|docx|xlsx|html?|md|markdown|csv|json)$/i.test(p)

interface ReviewComment {
  id: number
  path: string
  line: number
  text: string
}

// The Auxiliary Pane (Ba4, design 3.6): ONE side panel listing every
// deliverable of the current conversation -- plan/walkthrough artifacts plus
// one virtual "Changes" entry per diff group (derived from file_diff events;
// the diffs table is never migrated, design 3.4). The store's auxSelection
// deep-links a target; rail browsing is local state, overridden by the next
// deep-link via auxPaneOpenTick (the Ba2 tick idiom).
export function AuxiliaryPane(): React.JSX.Element | null {
  const target = useAppStore((s) => s.auxSelection)
  if (!target) return null
  return <AuxiliaryPaneInner target={target} />
}

function AuxiliaryPaneInner({ target }: { target: AuxSelection }): React.JSX.Element | null {
  const view = useAppStore((s) => s.view)
  const conversations = useAppStore((s) => s.conversations)
  const closeReview = useAppStore((s) => s.closeReview)
  const openTick = useAppStore((s) => s.auxPaneOpenTick)

  // Local rail selection, overridden by every deep-link (tick bump): the same
  // render-time adjustment the Ba2 pane used for its selection sync.
  const [sel, setSel] = useState<AuxSelection>(target)
  const [seenTick, setSeenTick] = useState(openTick)
  if (seenTick !== openTick) {
    setSeenTick(openTick)
    setSel(target)
  }

  // Escape closes the pane, unless a text field has focus. NOTE the real
  // scope: Monaco's input is a hidden .inputarea TEXTAREA that holds focus
  // whenever the editor does, so Escape is inert after any click into a diff
  // or code body until focus leaves the editor -- accepted (Ba4): closing the
  // pane mid-diff-reading was worse, and Monaco consumes Escape internally
  // (find widget, suggest) anyway.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        const t = e.target as HTMLElement | null
        if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return
        closeReview()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeReview])

  const convo = view.kind === 'conversation' ? conversations[view.id] : null
  if (!convo) return null

  const entries = deriveRailEntries(convo.events)
  const artifactFor = (artifactId: string): ArtifactEvent | undefined =>
    convo.events.find(
      (e): e is ArtifactEvent => e.type === 'artifact' && e.artifactId === artifactId
    )
  const diffExists = (diffId: string): boolean =>
    convo.events.some((e) => e.type === 'file_diff' && e.diffId === diffId)

  // Resolve the local selection against the live events; fall back to the
  // newest rail entry (e.g. a stale local pick after events changed).
  let resolved: AuxSelection | null = sel
  if (sel.kind === 'artifact' && !artifactFor(sel.artifactId)) resolved = null
  if (sel.kind === 'diff' && !diffExists(sel.diffId)) resolved = null
  if (!resolved && entries.length > 0) {
    const first = entries[0]
    resolved =
      first.kind === 'artifact'
        ? { kind: 'artifact', artifactId: first.event.artifactId }
        : { kind: 'diff', diffId: first.event.diffId }
  }
  const selectedArtifact =
    resolved?.kind === 'artifact' ? artifactFor(resolved.artifactId) : undefined

  return (
    <div className="review-side">
      <div className="artifact-pane-head">
        <span className="review-head-title">Artifacts</span>
        <button className="panel-close" title="Close panel" onClick={closeReview}>
          <IconClose />
        </button>
      </div>
      <div className="artifact-rail">
        {entries.map((entry) =>
          entry.kind === 'artifact' ? (
            <button
              key={entry.event.id}
              className={
                'artifact-rail-item' +
                (resolved?.kind === 'artifact' && resolved.artifactId === entry.event.artifactId
                  ? ' selected'
                  : '')
              }
              onClick={() => setSel({ kind: 'artifact', artifactId: entry.event.artifactId })}
            >
              <span className="artifact-rail-title">
                {ARTIFACT_TYPE_LABELS[entry.event.artifactType]} v{entry.event.version}
              </span>
              <span className={'artifact-status ' + entry.event.status}>
                {ARTIFACT_STATUS_LABELS[entry.event.status]}
              </span>
            </button>
          ) : (
            <button
              key={entry.event.id}
              className={
                'artifact-rail-item' +
                (resolved?.kind === 'diff' && resolved.diffId === entry.event.diffId
                  ? ' selected'
                  : '')
              }
              onClick={() => setSel({ kind: 'diff', diffId: entry.event.diffId })}
            >
              <span className="artifact-rail-title">Changes</span>
              <span className="artifact-rail-meta">
                {entry.event.files.length} file{entry.event.files.length === 1 ? '' : 's'}
              </span>
            </button>
          )
        )}
      </div>
      {resolved?.kind === 'diff' ? (
        <DiffViewer key={resolved.diffId} diffId={resolved.diffId} />
      ) : selectedArtifact ? (
        <ArtifactViewer
          selected={selectedArtifact}
          versions={versionsOfType(convo.events, selectedArtifact.artifactType)}
          convoEvents={convo.events}
          onSelectVersion={(artifactId) => setSel({ kind: 'artifact', artifactId })}
        />
      ) : null}
    </div>
  )
}

function DiffViewer({ diffId }: { diffId: string }): React.JSX.Element {
  const closeReview = useAppStore((s) => s.closeReview)
  const focusPath = useAppStore((s) => s.reviewFocusPath)
  const view = useAppStore((s) => s.view)
  const conversations = useAppStore((s) => s.conversations)
  const send = useAppStore((s) => s.send)
  const showToast = useAppStore((s) => s.showToast)
  const openFile = useAppStore((s) => s.openFile)
  const cmdHeld = useCmdHeld()
  const [diff, setDiff] = useState<FileDiff | null>(null)
  // 'overview' | 'review' | a file path (that file's full-code tab)
  const [tab, setTab] = useState<string>('review')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [comments, setComments] = useState<ReviewComment[]>([])
  const [previewMode, setPreviewMode] = useState<Record<string, boolean>>({})

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
    return () => {
      stale = true
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
    <>
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
            className={
              'review-tab' + (tab === f.path ? ' active' : '') + (cmdHeld ? ' cmd-openable' : '')
            }
            title={cmdHeld ? 'Cmd-click to open' : undefined}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey) openFile(f.path)
              else setTab(f.path)
            }}
          >
            <span className="code-mark">{'</>'}</span>
            {baseName(f.path)}
          </button>
        ))}
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
              const showPreview = previewMode[f.fileId] ?? isBinaryPreview(f.path)
              return (
                <div className="file-section" key={f.fileId}>
                  <div
                    className="file-section-head"
                    onClick={() => setCollapsed((c) => ({ ...c, [f.fileId]: !isCollapsed }))}
                  >
                    <span className="code-mark">{'</>'}</span>
                    <span className="fname">{baseName(f.path)}</span>
                    <span className="fdir">{dirName(f.path)}</span>
                    <button
                      className="mini-btn file-toggle"
                      onClick={(e) => {
                        e.stopPropagation()
                        setPreviewMode((m) => ({ ...m, [f.fileId]: !showPreview }))
                      }}
                    >
                      {showPreview ? 'Diff' : 'Preview'}
                    </button>
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
                      {showPreview ? (
                        <FilePreview fileId={f.fileId} />
                      ) : (
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
                      )}
                    </div>
                  ) : null}
                </div>
              )
            })}
            {files.length === 0 ? <div className="diff-loading">Loading changes…</div> : null}
          </div>
        </>
      ) : null}

      {fileTab
        ? (() => {
            const showTabPreview = previewMode[fileTab.fileId] ?? isBinaryPreview(fileTab.path)
            return (
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
                    <button
                      className="mini-btn"
                      onClick={() =>
                        setPreviewMode((m) => ({ ...m, [fileTab.fileId]: !showTabPreview }))
                      }
                    >
                      {showTabPreview ? 'Diff' : 'Preview'}
                    </button>
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
                  {showTabPreview ? (
                    <FilePreview fileId={fileTab.fileId} />
                  ) : (
                    <Suspense fallback={<div className="diff-loading">Loading…</div>}>
                      <MonacoCode
                        key={fileTab.fileId + ':code'}
                        value={fileTab.afterText}
                        language={languageFor(fileTab.path)}
                        commentedLines={commentedLines(fileTab.path)}
                        onAddComment={addComment(fileTab.path)}
                      />
                    </Suspense>
                  )}
                </div>
              </>
            )
          })()
        : null}

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
    </>
  )
}
