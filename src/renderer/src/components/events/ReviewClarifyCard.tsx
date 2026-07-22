import { useState } from 'react'
import type { Event, ReviewLens } from '@shared/types'
import { useAppStore } from '../../state/store'
import { FieldHint } from '../ui/FieldHint'
import './events.css'

type ReviewClarifyEvent = Extract<Event, { type: 'review_clarify' }>

const LENS_OPTIONS: { value: ReviewLens; label: string }[] = [
  { value: 'code', label: 'Code' },
  { value: 'security', label: 'Security' },
  { value: 'accessibility', label: 'Accessibility' },
  { value: 'performance', label: 'Performance' },
  { value: 'comprehensive', label: 'Comprehensive' }
]

export interface ReviewClarifyCardProps {
  event: ReviewClarifyEvent
  convoId: string
}

// Review mode (Phase H, Task 6): the opening dialog for the review panel when
// the classifier couldn't resolve a lens and/or a scope from the request.
// Matches .approval-card's visual weight (same chrome the command-approval
// and pipeline-proposal cards use) since this is the same kind of pending
// interaction -- the run is parked in 'awaiting-approval' until it's answered.
//
// A field that ISN'T being asked already has its answer on the event
// (event.lens / event.scope) and is never re-shown. When only one field is
// asked, picking/typing it is enough to confirm immediately (no extra click
// for the single-lens-chip case, per the confirm-on-pick UX pipeline cards and
// approval-opt rows already use elsewhere). When BOTH fields are asked, a
// lens chip only stages a local selection -- scope still needs typing -- so a
// Confirm button gates the final call until both are answered.
export function ReviewClarifyCard({
  event,
  convoId
}: ReviewClarifyCardProps): React.JSX.Element {
  const resolveReviewClarification = useAppStore((s) => s.resolveReviewClarification)
  const cancelRun = useAppStore((s) => s.cancelRun)
  const [chosenLens, setChosenLens] = useState<ReviewLens | null>(null)
  const [scopeInput, setScopeInput] = useState(event.scope ?? '')
  // IMPORTANT 3 fix: the re-dispatched panel run takes seconds before its
  // first finding appends, and during that window this card would otherwise
  // still be the last event and fully interactive -- a second Confirm (or, in
  // the lens-only case, a second chip click) would call
  // resolveReviewClarification again and start a second concurrent run on
  // the same conversation. Once the user has answered once, lock the whole
  // card down; there is nothing left here to interact with until the
  // re-dispatched run's own events replace it as "last event".
  const [submitted, setSubmitted] = useState(false)
  const scopeTrimmed = scopeInput.trim()
  const scopeInvalid = event.askScope && scopeTrimmed.length === 0
  const lensResolved = chosenLens ?? event.lens ?? null

  const pickLens = (lens: ReviewLens): void => {
    if (submitted) return
    if (event.askScope) {
      // Scope still needs an answer -- stage the pick, wait for Confirm.
      setChosenLens(lens)
      return
    }
    setSubmitted(true)
    resolveReviewClarification(convoId, lens, event.scope ?? '')
  }

  const confirm = (): void => {
    if (submitted || !lensResolved || scopeInvalid) return
    setSubmitted(true)
    resolveReviewClarification(convoId, lensResolved, scopeTrimmed)
  }

  const cancel = (): void => {
    if (submitted) return
    setSubmitted(true)
    cancelRun(convoId)
  }

  return (
    <div className="approval-card pulse-once clarify-card" id="pending-approval-card">
      <div className="approval-title">What should the review panel look at?</div>
      {event.askLens ? (
        <div className="clarify-field">
          <div className="clarify-label">Lens</div>
          <div className="lens-chips" role="group" aria-label="Review lens">
            {LENS_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={'lens-chip' + (chosenLens === opt.value ? ' selected' : '')}
                aria-pressed={chosenLens === opt.value}
                disabled={submitted}
                onClick={() => pickLens(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {event.askScope ? (
        <div className="clarify-field">
          <label className="clarify-label" htmlFor="review-clarify-scope">
            Scope
          </label>
          <input
            id="review-clarify-scope"
            className="set-input clarify-scope-input"
            type="text"
            value={scopeInput}
            placeholder="e.g. src, src/**/*.ts, 'everything', or 'what was just built'"
            disabled={submitted}
            onChange={(e) => setScopeInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirm()
            }}
          />
          <FieldHint show={scopeInvalid}>
            A path (src), a glob (src/**/*.ts), or &lsquo;everything&rsquo;.
          </FieldHint>
        </div>
      ) : null}
      <div className="approval-actions">
        {event.askScope ? (
          <button
            className="pill-btn primary"
            disabled={submitted || !lensResolved || scopeInvalid}
            onClick={confirm}
          >
            Confirm
          </button>
        ) : null}
        <button className="pill-btn" disabled={submitted} onClick={cancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}
