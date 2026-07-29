import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Event, FileDiffFile } from '@shared/types'
import { defaultsToRenderedPreview } from '@shared/fileClassification'
import { useAppStore, type ReviewComment } from '../../state/store'
import { useCmdHeld } from '../../lib/useCmdHeld'
import { IconClose, IconCopy, IconFile, IconRevert } from '../icons'
import { EmptyState } from '../ui/EmptyState'
import { ErrorCard } from '../ui/ErrorCard'
import { Loading } from '../ui/Loading'
import { Hint } from '../Hint'
import { useRovingTabs } from '../../lib/useRovingTabs'
import { DiffPanelContent } from './DiffPanelContent'
import { baseName } from './format'
import { REVIEW_MODE_CONTENT_PANEL_ID, reviewModeTabId } from './ids'
import { ApBrand } from './PaneHeader'
import type { BodyView, DiffLoadState } from './types'

const EMPTY_REVIEW_COMMENTS: ReviewComment[] = []

export function DiffPanel({
  diffId,
  rail,
  railVisible,
  railPanelLabelledBy
}: {
  diffId: string
  rail: React.ReactNode
  railVisible: boolean
  railPanelLabelledBy?: string
}): React.JSX.Element {
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
  const [resetForDiffId, setResetForDiffId] = useState(diffId)
  const mountedRef = useRef(true)
  const activeDiffIdRef = useRef(diffId)
  const comments = useAppStore((s) => s.diffReviewComments[diffId] ?? EMPTY_REVIEW_COMMENTS)
  const sending = useAppStore((s) => s.diffReviewSending[diffId] === true)
  const addDiffReviewComment = useAppStore((s) => s.addDiffReviewComment)
  const removeDiffReviewComment = useAppStore((s) => s.removeDiffReviewComment)
  const clearDiffReviewComments = useAppStore((s) => s.clearDiffReviewComments)
  const beginDiffReviewSend = useAppStore((s) => s.beginDiffReviewSend)
  const finishDiffReviewSend = useAppStore((s) => s.finishDiffReviewSend)

  // The rail stays mounted across diff changes so keyboard focus can remain
  // on its selected tab. Reset the state that the former keyed panel reset.
  if (resetForDiffId !== diffId) {
    setResetForDiffId(diffId)
    setDiffLoad({ status: 'loading', diffId })
    setMode('diff')
    setActiveFileId(null)
    setBodyView({})
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    activeDiffIdRef.current = diffId
  }, [diffId])

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

  // Per-file body view, defaulting rendered formats to Preview and
  // code/text to the red/green Diff (the review default).
  const viewFor = (f: FileDiffFile): BodyView =>
    bodyView[f.fileId] ?? (defaultsToRenderedPreview(f.path) ? 'preview' : 'diff')

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
      if (mountedRef.current && activeDiffIdRef.current === diffId) closeReview()
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
  const { tablistRef: modeRef, onKeyDown: onModeKeyDown } = useRovingTabs({
    ids: ['overview', 'diff'],
    selectedId: mode,
    onActivate: (nextMode) => setMode(nextMode as 'overview' | 'diff')
  })
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
        <div
          ref={modeRef}
          className="ap-segmented"
          role="tablist"
          aria-label="Review mode"
          onKeyDown={onModeKeyDown}
        >
          <button
            id={reviewModeTabId('overview')}
            role="tab"
            data-roving-tab-id="overview"
            aria-controls={REVIEW_MODE_CONTENT_PANEL_ID}
            aria-selected={mode === 'overview'}
            tabIndex={mode === 'overview' ? 0 : -1}
            className={mode === 'overview' ? 'active' : ''}
            onClick={() => setMode('overview')}
          >
            Overview
          </button>
          <button
            id={reviewModeTabId('diff')}
            role="tab"
            data-roving-tab-id="diff"
            aria-controls={REVIEW_MODE_CONTENT_PANEL_ID}
            aria-selected={mode === 'diff'}
            tabIndex={mode === 'diff' ? 0 : -1}
            className={mode === 'diff' ? 'active' : ''}
            onClick={() => setMode('diff')}
          >
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

      <DiffPanelContent
        rail={rail}
        railVisible={railVisible}
        railPanelLabelledBy={railPanelLabelledBy}
        mode={mode}
        turnPrompt={turnPrompt}
        files={files}
        activeFile={activeFile}
        body={body}
        cmdHeld={cmdHeld}
        emptyDiffState={emptyDiffState}
        setMode={setMode}
        setActiveFileId={setActiveFileId}
        setViewFor={setViewFor}
        openFile={openFile}
        commentedLines={commentedLines}
        addComment={addComment}
      />

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
