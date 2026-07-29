import { memo, useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Event } from '@shared/types'
import { useAppStore, type AuxSelection } from '../../state/store'
import { ArtifactViewer } from '../ArtifactViewer'
import { BrowserPane } from '../Browser/BrowserPane'
import { deriveRailEntries, versionsOfType, type ArtifactEvent } from '../../lib/auxRail'
import { ARTIFACT_STATUS_LABELS, ARTIFACT_TYPE_LABELS } from '../events/ArtifactCard'
import { IconClose } from '../icons'
import { Hint } from '../Hint'
import { useRovingTabs } from '../../lib/useRovingTabs'
import { AttachmentPanel } from './AttachmentPanel'
import { DiffPanel } from './DiffPanel'
import { FilePanel } from './FilePanel'
import { RAIL_CONTENT_PANEL_ID, railTabId } from './ids'
import { ApBrand } from './PaneHeader'

function ArtifactsPaneContentImplementation({
  target,
  browserVisible,
  browserHideRequest,
  onBrowserHideSettled
}: {
  target: AuxSelection
  browserVisible: boolean
  browserHideRequest: number | null
  onBrowserHideSettled: (request: number) => void
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
  const [seenTarget, setSeenTarget] = useState(target)
  const railTablistRef = useRef<HTMLDivElement>(null)
  if (seenTick !== openTick || seenTarget !== target) {
    setSeenTick(openTick)
    setSeenTarget(target)
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
          <BrowserPane
            visible={browserVisible}
            hideRequest={browserHideRequest}
            onHideSettled={onBrowserHideSettled}
          />
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
  const selectedRailId =
    resolved?.kind === 'artifact'
      ? `artifact:${resolved.artifactId}`
      : resolved?.kind === 'diff'
        ? `diff:${resolved.diffId}`
        : undefined
  // The deliverable rail is shared markup handed to whichever panel renders,
  // so its Row 1 header stays above it in the same .ap-panel column.
  const railVisible = entries.length > 1
  const rail = railVisible ? (
    <ArtifactRail
      entries={entries}
      resolved={resolved}
      onSelect={setSel}
      tablistRef={railTablistRef}
    />
  ) : null

  if (resolved?.kind === 'diff') {
    return (
      <DiffPanel
        diffId={resolved.diffId}
        rail={rail}
        railVisible={railVisible}
        railPanelLabelledBy={railVisible && selectedRailId ? railTabId(selectedRailId) : undefined}
      />
    )
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
        <div
          className="ap-artifact-body"
          role={railVisible ? 'tabpanel' : 'region'}
          id={railVisible ? RAIL_CONTENT_PANEL_ID : undefined}
          aria-labelledby={railVisible && selectedRailId ? railTabId(selectedRailId) : undefined}
          aria-label={railVisible ? undefined : 'Artifact content'}
        >
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

export const ArtifactsPaneContent = memo(ArtifactsPaneContentImplementation)

function ArtifactRail({
  entries,
  resolved,
  onSelect,
  tablistRef
}: {
  entries: ReturnType<typeof deriveRailEntries>
  resolved: AuxSelection | null
  onSelect: (selection: AuxSelection) => void
  tablistRef: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  const railIds = entries.map((entry) =>
    entry.kind === 'artifact' ? `artifact:${entry.event.artifactId}` : `diff:${entry.event.diffId}`
  )
  const selectedRailId =
    resolved?.kind === 'artifact'
      ? `artifact:${resolved.artifactId}`
      : resolved?.kind === 'diff'
        ? `diff:${resolved.diffId}`
        : undefined
  const { onKeyDown: onRailKeyDown } = useRovingTabs({
    ids: railIds,
    selectedId: selectedRailId,
    tablistRef,
    onActivate: (id) => {
      const entry = entries[railIds.indexOf(id)]
      if (!entry) return
      onSelect(
        entry.kind === 'artifact'
          ? { kind: 'artifact', artifactId: entry.event.artifactId }
          : { kind: 'diff', diffId: entry.event.diffId }
      )
    }
  })

  return (
    <div
      ref={tablistRef}
      className="ap-rail"
      role="tablist"
      aria-label="Artifacts"
      onKeyDown={onRailKeyDown}
    >
      {entries.map((entry, index) =>
        entry.kind === 'artifact' ? (
          <button
            key={entry.event.id}
            id={railTabId(railIds[index])}
            role="tab"
            data-roving-tab-id={railIds[index]}
            aria-controls={RAIL_CONTENT_PANEL_ID}
            aria-selected={selectedRailId === railIds[index]}
            tabIndex={selectedRailId === railIds[index] ? 0 : -1}
            className={
              'ap-rail-item' +
              (resolved?.kind === 'artifact' && resolved.artifactId === entry.event.artifactId
                ? ' selected'
                : '')
            }
            onClick={() => onSelect({ kind: 'artifact', artifactId: entry.event.artifactId })}
          >
            <span>
              {ARTIFACT_TYPE_LABELS[entry.event.artifactType]} v{entry.event.version}
            </span>
            <span className="ap-rail-meta">{ARTIFACT_STATUS_LABELS[entry.event.status]}</span>
          </button>
        ) : (
          <button
            key={entry.event.id}
            id={railTabId(railIds[index])}
            role="tab"
            data-roving-tab-id={railIds[index]}
            aria-controls={RAIL_CONTENT_PANEL_ID}
            aria-selected={selectedRailId === railIds[index]}
            tabIndex={selectedRailId === railIds[index] ? 0 : -1}
            className={
              'ap-rail-item' +
              (resolved?.kind === 'diff' && resolved.diffId === entry.event.diffId
                ? ' selected'
                : '')
            }
            onClick={() => onSelect({ kind: 'diff', diffId: entry.event.diffId })}
          >
            <span>Changes</span>
            <span className="ap-rail-meta">
              {entry.event.files.length} file{entry.event.files.length === 1 ? '' : 's'}
            </span>
          </button>
        )
      )}
    </div>
  )
}
