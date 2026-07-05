import { useEffect, useRef, useState } from 'react'
import type { Event } from '@shared/types'
import { useAppStore } from '../state/store'
import { Markdown } from '../lib/markdown'
import { ARTIFACT_STATUS_LABELS, ARTIFACT_TYPE_LABELS } from './events/ArtifactCard'
import { IconClose } from './icons'
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

// The artifacts pane (Ba1 read-only rail/viewer; Ba2 adds comments and the
// Proceed/Review loop). Lists the current conversation's plan/walkthrough
// artifacts newest first and renders the selected one through the sanitized
// markdown pipeline. Comments and the Proceed/Review actions render ONLY
// while a pending submit_plan call is paired to the selected artifact (the
// pairing seam, design 3.6) -- once the run proceeds, the artifact event
// re-emits under the same id (upsertEvent replaces by id) and the actions
// disappear on their own, no renderer bookkeeping required.
export function ArtifactPane({ artifactId }: { artifactId: string }): React.JSX.Element | null {
  const view = useAppStore((s) => s.view)
  const conversations = useAppStore((s) => s.conversations)
  const closeReview = useAppStore((s) => s.closeReview)
  const artifactComments = useAppStore((s) => s.artifactComments)
  const artifactPaneFocusFeedback = useAppStore((s) => s.artifactPaneFocusFeedback)
  const loadArtifactComments = useAppStore((s) => s.loadArtifactComments)
  const addArtifactComment = useAppStore((s) => s.addArtifactComment)
  const resolvePlanReview = useAppStore((s) => s.resolvePlanReview)
  const [selectedId, setSelectedId] = useState(artifactId)
  const [draftQuote, setDraftQuote] = useState<string | null>(null)
  const [draftBody, setDraftBody] = useState('')
  const [feedbackText, setFeedbackText] = useState('')
  const feedbackRef = useRef<HTMLTextAreaElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const seenFocusTick = useRef(artifactPaneFocusFeedback)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        const target = e.target as HTMLElement | null
        if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return
        closeReview()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeReview])

  const convo = view.kind === 'conversation' ? conversations[view.id] : null
  const artifacts = convo
    ? convo.events.filter((e): e is ArtifactEvent => e.type === 'artifact')
    : []
  const selected =
    artifacts.find((a) => a.artifactId === selectedId) ?? artifacts[artifacts.length - 1]

  const pendingCall =
    convo && selected && selected.artifactType === 'plan' && selected.status === 'pending-review'
      ? pendingPlanCallFor(convo.events, selected.artifactId)
      : undefined

  // Reload comments whenever the selected artifact changes.
  useEffect(() => {
    if (selected?.artifactId) void loadArtifactComments(selected.artifactId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.artifactId])

  // Focus + scroll the feedback textarea when the pending card's "Send
  // feedback" action ticks this counter. Skips the mount value so opening the
  // pane normally never steals focus.
  useEffect(() => {
    if (artifactPaneFocusFeedback === seenFocusTick.current) return
    seenFocusTick.current = artifactPaneFocusFeedback
    feedbackRef.current?.focus()
    feedbackRef.current?.scrollIntoView({ block: 'center' })
  }, [artifactPaneFocusFeedback])

  if (!convo) return null

  const comments = selected ? (artifactComments[selected.artifactId] ?? []) : []
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

  const submitDraft = (): void => {
    if (!selected || draftBody.trim() === '') return
    void addArtifactComment(selected.artifactId, draftQuote, draftBody.trim())
    setDraftQuote(null)
    setDraftBody('')
  }

  const proceed = (): void => {
    if (!pendingCall || !selected) return
    void resolvePlanReview(pendingCall.id, true).then((ok) => {
      if (ok) void loadArtifactComments(selected.artifactId)
    })
  }

  const requestReview = (): void => {
    if (!pendingCall || !selected) return
    void resolvePlanReview(pendingCall.id, false, feedbackText.trim() || undefined).then((ok) => {
      if (ok) {
        setFeedbackText('')
        void loadArtifactComments(selected.artifactId)
      }
    })
  }

  return (
    <div className="review-side">
      <div className="artifact-pane-head">
        <span className="review-head-title">Artifacts</span>
        <button className="panel-close" title="Close panel" onClick={closeReview}>
          <IconClose />
        </button>
      </div>
      <div className="artifact-rail">
        {[...artifacts].reverse().map((a) => (
          <button
            key={a.id}
            className={'artifact-rail-item' + (selected?.id === a.id ? ' selected' : '')}
            onClick={() => setSelectedId(a.artifactId)}
          >
            <span className="artifact-rail-title">
              {ARTIFACT_TYPE_LABELS[a.artifactType]} v{a.version}
            </span>
            <span className={'artifact-status ' + a.status}>
              {ARTIFACT_STATUS_LABELS[a.status]}
            </span>
          </button>
        ))}
      </div>
      <div className="review-scroll">
        {selected ? (
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
            {draftQuote !== null ? (
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
                  <button
                    className="plan-request-review"
                    onClick={() => {
                      setDraftQuote(null)
                      setDraftBody('')
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
            {comments.length > 0 ? (
              <div className="plan-comment-list">
                {comments.map((c) => (
                  <div key={c.id} className="plan-comment-item">
                    {c.quote ? (
                      <blockquote className="plan-comment-quote">{c.quote}</blockquote>
                    ) : null}
                    <div>{c.body}</div>
                    <span className={'plan-comment-chip' + (c.sentAt === null ? ' draft' : '')}>
                      {c.sentAt === null ? 'draft' : 'sent'}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
