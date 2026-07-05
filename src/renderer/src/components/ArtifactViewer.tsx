import { useEffect, useRef, useState } from 'react'
import type { Event } from '@shared/types'
import { useAppStore } from '../state/store'
import { Markdown } from '../lib/markdown'
import { ARTIFACT_STATUS_LABELS } from './events/ArtifactCard'
import './ReviewPanel.css'
import './events/events.css'

type ArtifactEvent = Extract<Event, { type: 'artifact' }>
type ToolCallEvent = Extract<Event, { type: 'tool_call' }>

// The live plan-review pairing: the pending submit_plan tool_call whose
// enriched input carries this artifact's id (graph.ts pairedApprovalInput /
// synthesizedApprovalCard). Present only while the run is parked at this
// plan's review, so it is exactly the window where Proceed/Review make sense.
function pendingPlanCallFor(events: Event[], artifactId: string): ToolCallEvent | undefined {
  return events.find(
    (e): e is ToolCallEvent =>
      e.type === 'tool_call' &&
      e.tool === 'submit_plan' &&
      e.approvalState === 'pending' &&
      typeof e.input === 'object' &&
      e.input !== null &&
      (e.input as { artifactId?: unknown }).artifactId === artifactId
  )
}

// The feedback-focus tick consumed so far. Module scope (not a ref) so it
// survives the viewer's unmount/remount cycle: a "Send feedback" press that
// MOUNTS the pane must still focus the box (a ref initialized at mount would
// swallow its own tick), while a stale tick from an earlier pane session must
// not refocus on every remount. Exactly one viewer mounts at a time (the
// AuxiliaryPane's single viewer slot), so a module singleton is safe.
let consumedFocusTick = 0

// The artifact half of the Auxiliary Pane (Ba4): renders ONE selected plan or
// walkthrough -- sanitized markdown body, comments, and (only while a pending
// submit_plan call is paired to it) the Ba2 Proceed/Review loop, unchanged.
// The rail and selection moved up into AuxiliaryPane; the version chips
// browse the same-type history (superseded plans viewable, design section 7).
// SECURITY: a superseded/approved/final version can never show actions --
// pendingCall requires status 'pending-review' AND a live pairing.
export function ArtifactViewer({
  selected,
  versions,
  convoEvents,
  onSelectVersion
}: {
  selected: ArtifactEvent
  versions: ArtifactEvent[]
  convoEvents: Event[]
  onSelectVersion: (artifactId: string) => void
}): React.JSX.Element {
  const target = useAppStore((s) => s.auxSelection)
  const artifactComments = useAppStore((s) => s.artifactComments)
  const artifactPaneFocusFeedback = useAppStore((s) => s.artifactPaneFocusFeedback)
  const loadArtifactComments = useAppStore((s) => s.loadArtifactComments)
  const addArtifactComment = useAppStore((s) => s.addArtifactComment)
  const resolvePlanReview = useAppStore((s) => s.resolvePlanReview)
  const [draftQuote, setDraftQuote] = useState<string | null>(null)
  const [draftBody, setDraftBody] = useState('')
  const [feedbackText, setFeedbackText] = useState('')
  const feedbackRef = useRef<HTMLTextAreaElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  const pendingCall =
    selected.artifactType === 'plan' && selected.status === 'pending-review'
      ? pendingPlanCallFor(convoEvents, selected.artifactId)
      : undefined

  // Drop any in-progress draft AND the feedback text when the selected
  // artifact changes: the quote was captured from the previous artifact's
  // body, and feedback typed against plan A must not pre-fill (and enable)
  // the Review button against a later plan B -- one click would send A's
  // text as B's review. The per-artifact mount key that used to guarantee
  // this is gone (Ba4: the pane no longer remounts per selection), so the
  // reset is explicit here. Render-time adjustment (react.dev "you might
  // not need an effect").
  const [draftArtifactId, setDraftArtifactId] = useState(selected.artifactId)
  if (draftArtifactId !== selected.artifactId) {
    setDraftArtifactId(selected.artifactId)
    setDraftQuote(null)
    setDraftBody('')
    setFeedbackText('')
  }

  // Reload comments whenever the selected artifact changes.
  useEffect(() => {
    void loadArtifactComments(selected.artifactId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected.artifactId])

  // Focus + scroll the feedback textarea when the pending card's "Send
  // feedback" action ticks this counter. Consumes the tick only once the
  // viewer is showing the store's deep-link target: the container's tick
  // sync can land a render later, and focusing before it would hit the
  // previous artifact's textarea (or nothing).
  useEffect(() => {
    if (artifactPaneFocusFeedback === consumedFocusTick) return
    if (target?.kind !== 'artifact' || selected.artifactId !== target.artifactId) return
    consumedFocusTick = artifactPaneFocusFeedback
    feedbackRef.current?.focus()
    feedbackRef.current?.scrollIntoView({ block: 'center' })
  }, [artifactPaneFocusFeedback, selected.artifactId, target])

  const comments = artifactComments[selected.artifactId] ?? []
  const unsentCount = comments.filter((c) => c.sentAt === null).length

  const onBodyMouseUp = (): void => {
    if (!pendingCall) return
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !bodyRef.current) return
    if (!bodyRef.current.contains(sel.anchorNode)) return
    const text = sel.toString().trim()
    if (text) {
      setDraftQuote(text)
      setDraftBody('')
    }
  }

  // Drafting is gated on pendingCall end to end: starting (onBodyMouseUp),
  // rendering the composer (below), and submitting here. Once the review
  // resolves from ANY path (these buttons, the card hotkey, another window),
  // the re-emitted tool_call event clears pendingCall and the composer both
  // hides and refuses to submit -- a resolved plan's comment set is final, so
  // no orphaned never-deliverable draft can be added after the fact.
  const submitDraft = (): void => {
    if (!pendingCall || draftBody.trim() === '') return
    void addArtifactComment(selected.artifactId, draftQuote, draftBody.trim())
    setDraftQuote(null)
    setDraftBody('')
  }

  const clearDraft = (): void => {
    setDraftQuote(null)
    setDraftBody('')
  }

  const proceed = (): void => {
    if (!pendingCall) return
    void resolvePlanReview(pendingCall.id, true).then((ok) => {
      if (ok) {
        // The review is resolved: drop any half-typed draft immediately rather
        // than waiting for the re-emitted event to hide the composer.
        clearDraft()
        void loadArtifactComments(selected.artifactId)
      }
    })
  }

  const requestReview = (): void => {
    if (!pendingCall) return
    void resolvePlanReview(pendingCall.id, false, feedbackText.trim() || undefined).then((ok) => {
      if (ok) {
        clearDraft()
        setFeedbackText('')
        void loadArtifactComments(selected.artifactId)
      }
    })
  }

  return (
    <div className="review-scroll">
      <div className="artifact-view">
        <div className="artifact-view-title-row">
          <div className="artifact-view-title">{selected.title}</div>
          <span className="artifact-version">v{selected.version}</span>
          <span className={'artifact-status ' + selected.status}>
            {ARTIFACT_STATUS_LABELS[selected.status]}
          </span>
          {pendingCall ? (
            <div className="plan-review-actions">
              <button className="plan-proceed" onClick={proceed}>
                Proceed
              </button>
              <button
                className="plan-request-review"
                disabled={unsentCount === 0 && feedbackText.trim() === ''}
                title="Needs at least one comment or a message"
                onClick={requestReview}
              >
                Review
              </button>
            </div>
          ) : null}
        </div>
        {versions.length > 1 ? (
          <div className="artifact-version-history">
            {versions.map((v) => (
              <button
                key={v.artifactId}
                className={
                  'version-chip' + (v.artifactId === selected.artifactId ? ' selected' : '')
                }
                onClick={() => onSelectVersion(v.artifactId)}
              >
                v{v.version} {ARTIFACT_STATUS_LABELS[v.status]}
              </button>
            ))}
          </div>
        ) : null}
        <div ref={bodyRef} onMouseUp={onBodyMouseUp}>
          <Markdown text={selected.body} />
        </div>
        {pendingCall ? (
          <textarea
            ref={feedbackRef}
            className="plan-feedback-box"
            placeholder="Feedback for the agent…"
            value={feedbackText}
            onChange={(e) => setFeedbackText(e.target.value)}
          />
        ) : null}
        {pendingCall && draftQuote !== null ? (
          <div className="comment-composer">
            <blockquote className="plan-comment-quote">{draftQuote}</blockquote>
            <textarea
              value={draftBody}
              onChange={(e) => setDraftBody(e.target.value)}
              placeholder="Add a comment…"
              autoFocus
            />
            <div className="comment-composer-actions">
              <button
                className="plan-request-review"
                disabled={draftBody.trim() === ''}
                onClick={submitDraft}
              >
                Add comment
              </button>
              <button className="plan-request-review" onClick={clearDraft}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
        {comments.length > 0 ? (
          <div className="plan-comment-list">
            {comments.map((c) => (
              <div key={c.id} className="plan-comment-item">
                {c.quote ? <blockquote className="plan-comment-quote">{c.quote}</blockquote> : null}
                <div>{c.body}</div>
                <span className={'plan-comment-chip' + (c.sentAt === null ? ' draft' : '')}>
                  {c.sentAt === null ? 'draft' : 'sent'}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}
