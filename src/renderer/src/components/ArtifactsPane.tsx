import { Suspense, lazy, memo, useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Event, FileDiff, FileDiffFile } from '@shared/types'
import { useAppStore, type AuxSelection, type ReviewComment } from '../state/store'
import { useCmdHeld } from '../lib/useCmdHeld'
import { ArtifactViewer } from './ArtifactViewer'
import { BrowserPane } from './Browser/BrowserPane'
import { FilePreview } from './FilePreview/FilePreview'
import { AttachmentPreview } from './AttachmentPreview/AttachmentPreview'
import { deriveRailEntries, versionsOfType, type ArtifactEvent } from '../lib/auxRail'
import { attachmentBadge } from '../lib/attachmentBadge'
import { ARTIFACT_STATUS_LABELS, ARTIFACT_TYPE_LABELS } from './events/ArtifactCard'
import { IconClose, IconCopy, IconFile, IconPaw, IconRevert } from './icons'
import { EmptyState } from './ui/EmptyState'
import { ErrorCard } from './ui/ErrorCard'
import { Loading } from './ui/Loading'
import { Hint } from './Hint'
import { useAnimatedUnmount } from '../lib/useAnimatedUnmount'
import { prefersReducedMotion } from '../lib/prefersReducedMotion'
import './ArtifactsPane.css'

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

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = sizeBytes / 1024
  let unit = units[0]
  for (let i = 1; i < units.length && value >= 1024; i++) {
    value /= 1024
    unit = units[i]
  }
  const displayed = (value >= 10 ? value.toFixed(0) : value.toFixed(1)).replace(/\.0$/, '')
  return `${displayed} ${unit}`
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

type DiffLoadState =
  | { status: 'loading'; diffId: string }
  | { status: 'ready'; diffId: string; diff: FileDiff }
  | { status: 'error'; diffId: string }

const EMPTY_REVIEW_COMMENTS: ReviewComment[] = []

// The Artifacts pane (Ba4, design 3.6), reskinned 2026-07-06 with the two-row
// Artifact Panel header. ONE side panel listing every deliverable of the
// current conversation -- plan/walkthrough artifacts plus one virtual "Changes"
// entry per diff group. The store's auxSelection deep-links a target; rail
// browsing is local state, overridden by the next deep-link via auxPaneOpenTick.
export function ArtifactsPane(): React.JSX.Element | null {
  const target = useAppStore((s) => s.auxSelection)
  const auxPaneWidth = useAppStore((s) => s.auxPaneWidth)
  const open = Boolean(target)
  const { mounted, state, completeExit } = useAnimatedUnmount(open, {
    exitCompletion: 'signal'
  })
  // Keep rendering the last selection through the exit slide (mirrors how
  // Popover retains its children while closing). Overwritten on every open,
  // so a stale target can never leak into the next open.
  const [lastTarget, setLastTarget] = useState(target)
  if (target && target !== lastTarget) setLastTarget(target)

  // Renderer transforms cannot move the main-process WebContentsView. Track
  // whether the shell itself has finished opening so native pixels stay
  // offscreen until their final bounds are stable.
  const [motion, setMotion] = useState(() => ({
    open,
    settled: open && prefersReducedMotion()
  }))
  if (motion.open !== open) {
    setMotion({ open, settled: open && prefersReducedMotion() })
  }

  const renderedTarget = target ?? lastTarget
  if (!mounted || !renderedTarget) return null
  const onTransitionEnd = (event: React.TransitionEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget || event.propertyName !== 'transform') return
    if (state === 'closing') {
      completeExit()
    } else {
      setMotion({ open: true, settled: true })
    }
  }

  return (
    <div
      className={'ap-panel' + (renderedTarget.kind === 'attachment' ? ' ap-attachment-panel' : '')}
      data-state={state}
      data-panel-kind={renderedTarget.kind}
      style={{ flexBasis: auxPaneWidth }}
      onTransitionEnd={onTransitionEnd}
    >
      <ArtifactsPaneInner
        target={renderedTarget}
        browserVisible={
          state === 'open' && motion.settled && renderedTarget.kind === 'browser' && open
        }
      />
    </div>
  )
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

function ArtifactsPaneInnerImplementation({
  target,
  browserVisible
}: {
  target: AuxSelection
  browserVisible: boolean
}): React.JSX.Element | null {
  const convo = useAppStore(
    useShallow((s) => {
      const conversationId =
        target.kind === 'attachment'
          ? target.conversationId
          : s.view.kind === 'conversation'
            ? s.view.id
            : null
      if (!conversationId) return null
      const c = s.conversations[conversationId]
      return c ? { auxEvents: c.auxEvents } : null
    })
  )
  const closeReview = useAppStore((s) => s.closeReview)
  const openTick = useAppStore((s) => s.auxPaneOpenTick)

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

  // F4: the browser target is self-contained -- no DB/events lookup needed. The
  // WebContentsView is a main-side singleton; the pane just reports its bounds.
  // Render it before the convo guard so it survives while events are loading.
  if (target.kind === 'browser') {
    return (
      <>
        <div className="ap-row ap-row-top">
          <ApBrand />
          <div className="ap-spacer" />
          <div className="ap-actions">
            <Hint label="Close panel" side="bottom">
              <button aria-label="Close panel" onClick={closeReview}>
                <IconClose />
              </button>
            </Hint>
          </div>
        </div>
        <div className="ap-browser-body">
          <BrowserPane visible={browserVisible} />
        </div>
      </>
    )
  }

  // Review mode: a finding target -- an arbitrary workspace file, not a
  // deliverable in the rail. Self-contained (fetches its own text) so, like
  // browser, it renders before the convo/rail machinery.
  if (sel.kind === 'file') {
    return <FilePanel key={sel.path + ':' + (sel.line ?? '')} path={sel.path} line={sel.line} />
  }

  if (sel.kind === 'attachment') {
    const event = convo?.auxEvents.find(
      (candidate): candidate is Extract<Event, { type: 'assistant_attachment' }> =>
        candidate.type === 'assistant_attachment' && candidate.attachment.id === sel.attachmentId
    )
    return (
      <AttachmentPanel
        key={`${sel.conversationId}:${sel.attachmentId}`}
        conversationId={sel.conversationId}
        attachmentId={sel.attachmentId}
        attachment={event?.attachment}
      />
    )
  }

  if (!convo) return null

  const entries = deriveRailEntries(convo.auxEvents)
  const artifactFor = (artifactId: string): ArtifactEvent | undefined =>
    convo.auxEvents.find(
      (e): e is ArtifactEvent => e.type === 'artifact' && e.artifactId === artifactId
    )
  const diffExists = (diffId: string): boolean =>
    convo.auxEvents.some((e) => e.type === 'file_diff' && e.diffId === diffId)

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
      <>
        <div className="ap-row ap-row-top">
          <ApBrand />
          <div className="ap-spacer" />
          <div className="ap-actions">
            <Hint label="Close panel" side="bottom">
              <button aria-label="Close panel" onClick={closeReview}>
                <IconClose />
              </button>
            </Hint>
          </div>
        </div>
        {rail}
        <div className="ap-artifact-body">
          <ArtifactViewer
            selected={selectedArtifact}
            versions={versionsOfType(convo.auxEvents, selectedArtifact.artifactType)}
            convoEvents={convo.auxEvents}
            onSelectVersion={(artifactId) => setSel({ kind: 'artifact', artifactId })}
          />
        </div>
      </>
    )
  }
  return (
    <>
      <div className="ap-row ap-row-top">
        <ApBrand />
        <div className="ap-spacer" />
        <div className="ap-actions">
          <Hint label="Close panel" side="bottom">
            <button aria-label="Close panel" onClick={closeReview}>
              <IconClose />
            </button>
          </Hint>
        </div>
      </div>
    </>
  )
}

const ArtifactsPaneInner = memo(ArtifactsPaneInnerImplementation)

function AttachmentPanel({
  conversationId,
  attachmentId,
  attachment
}: {
  conversationId: string
  attachmentId: string
  attachment?: Extract<Event, { type: 'assistant_attachment' }>['attachment']
}): React.JSX.Element {
  const closeReview = useAppStore((s) => s.closeReview)
  const showToast = useAppStore((s) => s.showToast)
  const [savePending, setSavePending] = useState(false)
  const badge = attachment ? attachmentBadge(attachment.name, attachment.mime) : null

  const download = async (): Promise<void> => {
    if (savePending) return
    setSavePending(true)
    try {
      const result = await window.bearcode.attachments.save(conversationId, attachmentId)
      if (result === 'saved') showToast('Attachment saved')
    } catch {
      showToast('Could not save attachment')
    } finally {
      setSavePending(false)
    }
  }

  return (
    <>
      <div className="ap-row ap-row-top ap-attachment-header">
        <span className="ap-attachment-name">{attachment?.name ?? 'Attachment'}</span>
        {attachment && badge ? (
          <>
            <span className={`ap-attachment-badge ${badge.colorClass}`}>{badge.label}</span>
            <span className="ap-attachment-size">{formatBytes(attachment.sizeBytes)}</span>
          </>
        ) : null}
        <div className="ap-spacer" />
        <div className="ap-actions">
          {attachment ? (
            <button disabled={savePending} onClick={() => void download()}>
              Download…
            </button>
          ) : null}
          <Hint label="Close panel" side="bottom">
            <button aria-label="Close panel" onClick={closeReview}>
              <IconClose />
            </button>
          </Hint>
        </div>
      </div>
      <div className="ap-attachment-body">
        {attachment ? (
          <AttachmentPreview conversationId={conversationId} attachmentId={attachmentId} />
        ) : (
          <div className="ap-attachment-missing">Attachment is no longer available</div>
        )}
      </div>
    </>
  )
}

// Review mode: a single workspace file opened at a finding's exact line. It
// fetches the file's text through the jailed read-file IPC (never in the
// renderer) and hands it to MonacoCode with revealLine, so clicking a finding
// lands the cursor where it points -- read-only, no rail, no diff.
function FilePanel({ path, line }: { path: string; line?: number }): React.JSX.Element {
  const closeReview = useAppStore((s) => s.closeReview)
  const convoId = useAppStore((s) => (s.view.kind === 'conversation' ? s.view.id : null))
  const requestId = convoId ? `${convoId}:${path}` : null
  const [fileLoad, setFileLoad] = useState({
    requestId: null as string | null,
    content: null as string | null,
    failed: false
  })
  const content = fileLoad.requestId === requestId ? fileLoad.content : null
  const failed = fileLoad.requestId === requestId && fileLoad.failed

  useEffect(() => {
    if (!convoId || !requestId) return undefined
    let stale = false
    void window.bearcode.shell
      .readFile(convoId, path)
      .then((text) => {
        if (!stale) setFileLoad({ requestId, content: text, failed: false })
      })
      .catch(() => {
        if (!stale) setFileLoad({ requestId, content: null, failed: true })
      })
    return () => {
      stale = true
    }
  }, [convoId, path, requestId])

  return (
    <>
      <div className="ap-row ap-row-top">
        <ApBrand />
        <span className="ap-file-name">
          {baseName(path)}
          {line ? `:${line}` : ''}
        </span>
        <div className="ap-spacer" />
        <div className="ap-actions">
          <Hint label="Close panel" side="bottom">
            <button aria-label="Close panel" onClick={closeReview}>
              <IconClose />
            </button>
          </Hint>
        </div>
      </div>
      <div className="ap-body">
        {failed ? (
          <div className="diff-loading">
            <EmptyState title="Couldn't open file" hint={path} />
          </div>
        ) : content === null ? (
          <div className="diff-loading">
            <Loading label="Loading file…" />
          </div>
        ) : (
          <Suspense fallback={<Loading />}>
            <MonacoCode key={path} value={content} language={languageFor(path)} revealLine={line} />
          </Suspense>
        )}
      </div>
    </>
  )
}

function DiffPanel({ diffId, rail }: { diffId: string; rail: React.ReactNode }): React.JSX.Element {
  const closeReview = useAppStore((s) => s.closeReview)
  const focusPath = useAppStore((s) => s.reviewFocusPath)
  const view = useAppStore((s) => s.view)
  const convoId = view.kind === 'conversation' ? view.id : null
  const convo = useAppStore(
    useShallow((s) => {
      if (s.view.kind !== 'conversation') return null
      const c = s.conversations[s.view.id]
      return c ? { auxEvents: c.auxEvents } : null
    })
  )
  const send = useAppStore((s) => s.send)
  const showToast = useAppStore((s) => s.showToast)
  const openFile = useAppStore((s) => s.openFile)
  const cmdHeld = useCmdHeld()
  const [diffLoad, setDiffLoad] = useState<DiffLoadState>({ status: 'loading', diffId })
  const [mode, setMode] = useState<'overview' | 'diff'>('diff')
  const [activeFileId, setActiveFileId] = useState<string | null>(null)
  const [bodyView, setBodyView] = useState<Record<string, BodyView>>({})
  const mountedRef = useRef(true)
  const comments = useAppStore((s) => s.diffReviewComments[diffId] ?? EMPTY_REVIEW_COMMENTS)
  const sending = useAppStore((s) => s.diffReviewSending[diffId] === true)
  const addDiffReviewComment = useAppStore((s) => s.addDiffReviewComment)
  const removeDiffReviewComment = useAppStore((s) => s.removeDiffReviewComment)
  const clearDiffReviewComments = useAppStore((s) => s.clearDiffReviewComments)
  const beginDiffReviewSend = useAppStore((s) => s.beginDiffReviewSend)
  const finishDiffReviewSend = useAppStore((s) => s.finishDiffReviewSend)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // The user prompt this diff belongs to, for the For-Turn context line.
  let turnPrompt = ''
  if (convo) {
    let sawDiff = false
    for (let i = convo.auxEvents.length - 1; i >= 0; i--) {
      const ev: Event = convo.auxEvents[i]
      if (ev.type === 'file_diff' && ev.diffId === diffId) sawDiff = true
      else if (sawDiff && ev.type === 'user_message') {
        turnPrompt = ev.text
        break
      }
    }
  }

  useEffect(() => {
    let stale = false
    void window.bearcode.diffs
      .get(diffId)
      .then((diff) => {
        if (!stale) setDiffLoad({ status: 'ready', diffId, diff })
      })
      .catch(() => {
        if (!stale) setDiffLoad({ status: 'error', diffId })
      })
    return () => {
      stale = true
    }
  }, [diffId])

  // A chip or step-row click focuses that file: switch to diff mode on it.
  const seenFocus = useRef<string | null>(null)
  useEffect(() => {
    if (
      !focusPath ||
      focusPath === seenFocus.current ||
      diffLoad.status !== 'ready' ||
      diffLoad.diffId !== diffId
    ) {
      return
    }

    let stale = false
    seenFocus.current = focusPath
    const focusedFile = diffLoad.diff.files.find((file) => file.path === focusPath)
    queueMicrotask(() => {
      if (stale) return
      if (focusedFile) setActiveFileId(focusedFile.fileId)
      setMode('diff')
    })
    return () => {
      stale = true
    }
  }, [diffId, diffLoad, focusPath])

  const currentDiffLoad =
    diffLoad.diffId === diffId ? diffLoad : ({ status: 'loading', diffId } as const)
  const diff = currentDiffLoad.status === 'ready' ? currentDiffLoad.diff : null
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
    setDiffLoad((load) =>
      load.status === 'ready'
        ? {
            ...load,
            diff: {
              ...load.diff,
              files: load.diff.files.map((f) =>
                f.fileId === file.fileId ? { ...f, state: 'reverted' } : f
              )
            }
          }
        : load
    )
    showToast('Change reverted')
  }

  // The store action is stable, so Monaco can safely retain this callback.
  const addComment = (path: string) => (line: number, text: string) => {
    addDiffReviewComment(diffId, { path, line, text })
  }

  const sendComments = (): void => {
    if (!convoId || comments.length === 0 || !beginDiffReviewSend(diffId)) return
    const snapshot = comments
    const lines = snapshot.map((c) => `- ${c.path} line ${c.line}: ${c.text}`)
    void (async () => {
      let accepted = false
      try {
        accepted = await send(convoId, `Please address these review comments:\n${lines.join('\n')}`)
      } catch {
        // Store dispatch resolves false on failure. This catch protects the
        // drafts if a non-store test double or future caller rejects instead.
      }
      finishDiffReviewSend(diffId)
      if (!accepted) return
      clearDiffReviewComments(
        diffId,
        snapshot.map((comment) => comment.id)
      )
      showToast(`Sent ${snapshot.length === 1 ? '1 comment' : `${snapshot.length} comments`}`)
      if (mountedRef.current) closeReview()
    })()
  }

  const commentedLines = (path: string): number[] =>
    comments.filter((c) => c.path === path).map((c) => c.line)

  const copyActive = (): void => {
    if (!activeFile) return
    const name = baseName(activeFile.path)
    void window.bearcode.clipboard
      .write(activeFile.afterText)
      .then(() => showToast(`Copied ${name}`))
  }

  const body = activeFile ? viewFor(activeFile) : 'diff'
  const emptyDiffState =
    currentDiffLoad.status === 'loading' ? (
      <Loading label="Loading changes…" />
    ) : currentDiffLoad.status === 'error' ? (
      <ErrorCard>Could not load changes</ErrorCard>
    ) : (
      <EmptyState title="No changes" />
    )

  return (
    <>
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
              <Hint label="Copy file contents" side="bottom">
                <button aria-label="Copy file" onClick={copyActive}>
                  <IconCopy />
                </button>
              </Hint>
              <Hint label="Open in editor" side="bottom">
                <button
                  aria-label="Open in editor"
                  onClick={() => void window.bearcode.diffs.open(activeFile.fileId)}
                >
                  <IconFile />
                </button>
              </Hint>
              {activeFile.state !== 'reverted' ? (
                <Hint label="Revert change" side="bottom">
                  <button aria-label="Revert change" onClick={() => void revert(activeFile)}>
                    <IconRevert />
                  </button>
                </Hint>
              ) : null}
            </>
          ) : null}
          <Hint label="Close panel" side="bottom">
            <button aria-label="Close panel" onClick={closeReview}>
              <IconClose />
            </button>
          </Hint>
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
          {files.length === 0 ? <div className="diff-loading">{emptyDiffState}</div> : null}
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
              <div className="diff-loading">{emptyDiffState}</div>
            ) : body === 'preview' ? (
              <FilePreview fileId={activeFile.fileId} />
            ) : body === 'code' ? (
              <Suspense fallback={<Loading />}>
                <MonacoCode
                  key={activeFile.fileId + ':code'}
                  value={activeFile.afterText}
                  language={languageFor(activeFile.path)}
                  commentedLines={commentedLines(activeFile.path)}
                  onAddComment={addComment(activeFile.path)}
                />
              </Suspense>
            ) : (
              <Suspense fallback={<Loading />}>
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
                <Hint label="Remove comment" side="top">
                  <button
                    className="comment-del"
                    aria-label="Remove comment"
                    onClick={() => removeDiffReviewComment(diffId, c.id)}
                  >
                    <IconClose size={12} />
                  </button>
                </Hint>
              </div>
            ))}
          </div>
          <div className="comment-send">
            <button className="foot-btn accept" onClick={sendComments} disabled={sending}>
              Send {comments.length === 1 ? '1 comment' : `${comments.length} comments`}
            </button>
          </div>
        </>
      ) : null}
    </>
  )
}
