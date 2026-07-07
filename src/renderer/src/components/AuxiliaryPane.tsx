import { Suspense, lazy, useEffect, useState } from 'react'
import type { Event, FileDiff, FileDiffFile } from '@shared/types'
import { useAppStore, type AuxSelection } from '../state/store'
import { useCmdHeld } from '../lib/useCmdHeld'
import { ArtifactViewer } from './ArtifactViewer'
import { FilePreview } from './FilePreview/FilePreview'
import { deriveRailEntries, versionsOfType, type ArtifactEvent } from '../lib/auxRail'
import { ARTIFACT_STATUS_LABELS, ARTIFACT_TYPE_LABELS } from './events/ArtifactCard'
import { IconClose, IconCopy, IconFile, IconPaw, IconRevert } from './icons'
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

// Which formats DEFAULT to the rendered Preview instead of the Diff/source
// view. Only genuinely-binary/rich formats belong here: their raw bytes are
// meaningless as "source", so rendering is the only sensible default. Code and
// text formats (html, md, csv, json, ...) DEFAULT to the Diff/Monaco view --
// this is a code-review pane, and reviewing an html/md artifact means reading
// the source. Preview is still one click away via the per-file toggle for them.
// (main isn't importable from the renderer, so this lives here rather than
// importing src/main/preview/classify.ts, which can still *render* every kind.)
const isBinaryPreview = (p: string): boolean =>
  /\.(png|jpe?g|gif|webp|bmp|svg|pdf|docx|xlsx)$/i.test(p)

type BodyView = 'diff' | 'code' | 'preview'

interface ReviewComment {
  id: number
  path: string
  line: number
  text: string
}

// The Auxiliary Pane (Ba4, design 3.6), reskinned 2026-07-06 with the two-row
// Artifact Panel header. ONE side panel listing every deliverable of the
// current conversation -- plan/walkthrough artifacts plus one virtual "Changes"
// entry per diff group. The store's auxSelection deep-links a target; rail
// browsing is local state, overridden by the next deep-link via auxPaneOpenTick.
export function AuxiliaryPane(): React.JSX.Element | null {
  const target = useAppStore((s) => s.auxSelection)
  if (!target) return null
  return <AuxiliaryPaneInner target={target} />
}

// The paw + "Artifacts" wordmark that opens Row 1 of every panel variant.
function ApBrand(): React.JSX.Element {
  return (
    <>
      <span className="ap-paw" aria-hidden="true">
        <IconPaw />
      </span>
      <span className="ap-title">Artifacts</span>
    </>
  )
}

function AuxiliaryPaneInner({ target }: { target: AuxSelection }): React.JSX.Element | null {
  const view = useAppStore((s) => s.view)
  const conversations = useAppStore((s) => s.conversations)
  const closeReview = useAppStore((s) => s.closeReview)
  const openTick = useAppStore((s) => s.auxPaneOpenTick)
  const auxPaneWidth = useAppStore((s) => s.auxPaneWidth)

  // Local rail selection, overridden by every deep-link (tick bump).
  const [sel, setSel] = useState<AuxSelection>(target)
  const [seenTick, setSeenTick] = useState(openTick)
  if (seenTick !== openTick) {
    setSeenTick(openTick)
    setSel(target)
  }

  // Escape closes the pane, unless a text field has focus (Monaco's hidden
  // .inputarea TEXTAREA holds focus inside a diff -- accepted, Ba4).
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

  // The deliverable rail is shared markup handed to whichever panel renders,
  // so its Row 1 header stays above it in the same .ap-panel column.
  const rail =
    entries.length > 1 ? (
      <div className="ap-rail">
        {entries.map((entry) =>
          entry.kind === 'artifact' ? (
            <button
              key={entry.event.id}
              className={
                'ap-rail-item' +
                (resolved?.kind === 'artifact' && resolved.artifactId === entry.event.artifactId
                  ? ' selected'
                  : '')
              }
              onClick={() => setSel({ kind: 'artifact', artifactId: entry.event.artifactId })}
            >
              <span>
                {ARTIFACT_TYPE_LABELS[entry.event.artifactType]} v{entry.event.version}
              </span>
              <span className="ap-rail-meta">{ARTIFACT_STATUS_LABELS[entry.event.status]}</span>
            </button>
          ) : (
            <button
              key={entry.event.id}
              className={
                'ap-rail-item' +
                (resolved?.kind === 'diff' && resolved.diffId === entry.event.diffId
                  ? ' selected'
                  : '')
              }
              onClick={() => setSel({ kind: 'diff', diffId: entry.event.diffId })}
            >
              <span>Changes</span>
              <span className="ap-rail-meta">
                {entry.event.files.length} file{entry.event.files.length === 1 ? '' : 's'}
              </span>
            </button>
          )
        )}
      </div>
    ) : null

  if (resolved?.kind === 'diff') {
    return <DiffPanel key={resolved.diffId} diffId={resolved.diffId} rail={rail} />
  }
  if (selectedArtifact) {
    return (
      <div className="ap-panel" style={{ flexBasis: auxPaneWidth }}>
        <div className="ap-row ap-row-top">
          <ApBrand />
          <div className="ap-spacer" />
          <div className="ap-actions">
            <button aria-label="Close panel" title="Close panel" onClick={closeReview}>
              <IconClose />
            </button>
          </div>
        </div>
        {rail}
        <div className="ap-artifact-body">
          <ArtifactViewer
            selected={selectedArtifact}
            versions={versionsOfType(convo.events, selectedArtifact.artifactType)}
            convoEvents={convo.events}
            onSelectVersion={(artifactId) => setSel({ kind: 'artifact', artifactId })}
          />
        </div>
      </div>
    )
  }
  return (
    <div className="ap-panel" style={{ flexBasis: auxPaneWidth }}>
      <div className="ap-row ap-row-top">
        <ApBrand />
        <div className="ap-spacer" />
        <div className="ap-actions">
          <button aria-label="Close panel" title="Close panel" onClick={closeReview}>
            <IconClose />
          </button>
        </div>
      </div>
    </div>
  )
}

function DiffPanel({
  diffId,
  rail
}: {
  diffId: string
  rail: React.ReactNode
}): React.JSX.Element {
  const closeReview = useAppStore((s) => s.closeReview)
  const focusPath = useAppStore((s) => s.reviewFocusPath)
  const view = useAppStore((s) => s.view)
  const conversations = useAppStore((s) => s.conversations)
  const auxPaneWidth = useAppStore((s) => s.auxPaneWidth)
  const send = useAppStore((s) => s.send)
  const showToast = useAppStore((s) => s.showToast)
  const openFile = useAppStore((s) => s.openFile)
  const cmdHeld = useCmdHeld()
  const [diff, setDiff] = useState<FileDiff | null>(null)
  const [mode, setMode] = useState<'overview' | 'diff'>('diff')
  const [activeFileId, setActiveFileId] = useState<string | null>(null)
  const [bodyView, setBodyView] = useState<Record<string, BodyView>>({})
  const [comments, setComments] = useState<ReviewComment[]>([])

  const convoId = view.kind === 'conversation' ? view.id : null
  const convo = convoId ? conversations[convoId] : null

  // The user prompt this diff belongs to, for the For-Turn context line.
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

  // A chip or step-row click focuses that file: switch to diff mode on it.
  const [seenFocus, setSeenFocus] = useState<string | null>(null)
  if (focusPath && focusPath !== seenFocus) {
    setSeenFocus(focusPath)
    setActiveFileId(diff?.files.find((f) => f.path === focusPath)?.fileId ?? null)
    setMode('diff')
  }

  const files = diff?.files ?? []
  const activeFile = files.find((f) => f.fileId === activeFileId) ?? files[0]

  // Per-file body view, defaulting binary/rich formats to Preview and
  // code/text to the red/green Diff (the review default).
  const viewFor = (f: FileDiffFile): BodyView =>
    bodyView[f.fileId] ?? (isBinaryPreview(f.path) ? 'preview' : 'diff')

  const setViewFor = (fileId: string, v: BodyView): void =>
    setBodyView((m) => ({ ...m, [fileId]: v }))

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

  // Functional update: Monaco captures this closure once at mount.
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

  const copyActive = (): void => {
    if (!activeFile) return
    void navigator.clipboard?.writeText(activeFile.afterText)
    showToast(`Copied ${baseName(activeFile.path)}`)
  }

  const body = activeFile ? viewFor(activeFile) : 'diff'

  return (
    <div className="ap-panel" style={{ flexBasis: auxPaneWidth }}>
      {/* Row 1: brand + Overview/Diff mode toggle + actions */}
      <div className="ap-row ap-row-top">
        <ApBrand />
        <div className="ap-segmented">
          <button
            className={mode === 'overview' ? 'active' : ''}
            onClick={() => setMode('overview')}
          >
            Overview
          </button>
          <button className={mode === 'diff' ? 'active' : ''} onClick={() => setMode('diff')}>
            Diff · {files.length}
          </button>
        </div>
        <div className="ap-spacer" />
        <div className="ap-actions">
          {mode === 'diff' && activeFile ? (
            <>
              <button aria-label="Copy file" title="Copy file contents" onClick={copyActive}>
                <IconCopy />
              </button>
              <button
                aria-label="Open in editor"
                title="Open in editor"
                onClick={() => void window.bearcode.diffs.open(activeFile.fileId)}
              >
                <IconFile />
              </button>
              {activeFile.state !== 'reverted' ? (
                <button
                  aria-label="Revert change"
                  title="Revert change"
                  onClick={() => void revert(activeFile)}
                >
                  <IconRevert />
                </button>
              ) : null}
            </>
          ) : null}
          <button aria-label="Close panel" title="Close panel" onClick={closeReview}>
            <IconClose />
          </button>
        </div>
      </div>

      {rail}

      {mode === 'overview' ? (
        <div className="ap-overview">
          <div className="overview-title">Overview</div>
          {turnPrompt ? <div className="overview-prompt">{turnPrompt}</div> : null}
          <div className="overview-sub">
            {files.length} file{files.length === 1 ? '' : 's'} changed
          </div>
          {files.map((f) => (
            <button
              key={f.fileId}
              className="overview-file"
              onClick={() => {
                setActiveFileId(f.fileId)
                setMode('diff')
              }}
            >
              <span className="code-mark">{'</>'}</span>
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
          {files.length === 0 ? <div className="diff-loading">Loading changes…</div> : null}
        </div>
      ) : (
        <>
          {/* Row 2: file tabs + Diff/Code/Preview toggle */}
          <div className="ap-row ap-row-tabs">
            <div className="ap-tabs">
              {files.map((f) => (
                <button
                  key={f.fileId}
                  className={
                    'ap-tab' +
                    (f.fileId === activeFile?.fileId ? ' active' : '') +
                    (cmdHeld ? ' cmd-openable' : '')
                  }
                  title={cmdHeld ? 'Cmd-click to open in editor' : undefined}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey) openFile(f.path)
                    else setActiveFileId(f.fileId)
                  }}
                >
                  <span className="code-mark">{'</>'}</span>
                  <span>{baseName(f.path)}</span>
                  {f.state === 'reverted' ? (
                    <span className="ap-diffstat">
                      <span className="reverted">Reverted</span>
                    </span>
                  ) : (
                    <span className="ap-diffstat">
                      <span className="add">+{f.additions}</span>
                      <span className="rem">-{f.deletions}</span>
                    </span>
                  )}
                  {f.fileId === activeFile?.fileId ? (
                    <svg
                      className="ap-clawmark"
                      width="16"
                      height="6"
                      viewBox="0 0 16 6"
                      aria-hidden="true"
                    >
                      <path d="M1 5 L5.3 1" />
                      <path d="M5.3 5 L9.7 1" />
                      <path d="M9.7 5 L14 1" />
                    </svg>
                  ) : null}
                </button>
              ))}
            </div>
            {activeFile ? (
              <div className="ap-segmented">
                <button
                  className={body === 'diff' ? 'active' : ''}
                  onClick={() => setViewFor(activeFile.fileId, 'diff')}
                >
                  Diff
                </button>
                <button
                  className={body === 'code' ? 'active' : ''}
                  onClick={() => setViewFor(activeFile.fileId, 'code')}
                >
                  Code
                </button>
                <button
                  className={body === 'preview' ? 'active' : ''}
                  onClick={() => setViewFor(activeFile.fileId, 'preview')}
                >
                  Preview
                </button>
              </div>
            ) : null}
          </div>

          {/* Body */}
          <div className="ap-body">
            {!activeFile ? (
              <div className="diff-loading">Loading changes…</div>
            ) : body === 'preview' ? (
              <FilePreview fileId={activeFile.fileId} />
            ) : body === 'code' ? (
              <Suspense fallback={<div className="diff-loading">Loading…</div>}>
                <MonacoCode
                  key={activeFile.fileId + ':code'}
                  value={activeFile.afterText}
                  language={languageFor(activeFile.path)}
                  commentedLines={commentedLines(activeFile.path)}
                  onAddComment={addComment(activeFile.path)}
                />
              </Suspense>
            ) : (
              <Suspense fallback={<div className="diff-loading">Loading…</div>}>
                {activeFile.status === 'created' ? (
                  <MonacoCode
                    key={activeFile.fileId + ':diff'}
                    value={activeFile.afterText}
                    language={languageFor(activeFile.path)}
                    commentedLines={commentedLines(activeFile.path)}
                    onAddComment={addComment(activeFile.path)}
                    washAdded
                  />
                ) : (
                  <MonacoDiff
                    key={activeFile.fileId + ':diff'}
                    original={activeFile.beforeText}
                    modified={activeFile.afterText}
                    language={languageFor(activeFile.path)}
                    commentedLines={commentedLines(activeFile.path)}
                    onAddComment={addComment(activeFile.path)}
                  />
                )}
              </Suspense>
            )}
          </div>
        </>
      )}

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
