import { memo, useState } from 'react'
import type { Event } from '@shared/types'
import { Markdown } from '../../lib/markdown'
import { IconChevronRightSmall } from '../icons'
import './events.css'

type CouncilSeatEvent = Extract<Event, { type: 'council_seat' }>

// Ursa Modes (Task 5): the collapsed deliberation block for a council-mode turn.
// Each `council_seat` event (a member's initial answer, or its anonymized peer
// review of the others) renders as a labeled row that expands to the seat's
// markdown-rendered text; the chair's synthesis is the turn's normal
// assistant_text and is NOT shown here. Rows are grouped by stage -- answers
// first, then peer reviews -- each under a small stage label. Ursa-accent chrome
// consistent with UrsaStepDivider. A failed seat shows a static "failed" row
// (no body to expand). Older streams carry no council_seat events, so the
// panel simply doesn't render (ConversationView gates on a non-empty list).

// One seat's row: the ⚖ badge + short model label + stage word, expandable to
// the full markdown text. Failed answers render static (nothing to expand).
function CouncilSeatRow({ seat }: { seat: CouncilSeatEvent }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const failed = seat.status === 'failed'
  const stageWord = seat.stage === 'answer' ? 'seat' : 'review'
  return (
    <div className={'step council-seat' + (open && !failed ? ' open' : '') + (failed ? ' failed' : '')}>
      <div
        className={'step-row' + (failed ? ' static' : '')}
        onClick={failed ? undefined : () => setOpen((o) => !o)}
      >
        <span className="council-seat-badge" aria-hidden="true">
          ⚖
        </span>
        <span className="council-seat-name">{seat.seat}</span>
        <span className="ursa-step-sep">·</span>
        <span className="council-seat-stage">{stageWord}</span>
        {failed ? (
          <span className="council-seat-failed">failed</span>
        ) : (
          <span className="chev">
            <IconChevronRightSmall />
          </span>
        )}
      </div>
      {failed ? null : (
        <div className="step-body md">
          <Markdown text={seat.text} />
        </div>
      )}
    </div>
  )
}

function CouncilPanelImpl({ seats }: { seats: CouncilSeatEvent[] }): React.JSX.Element | null {
  if (seats.length === 0) return null
  const answers = seats.filter((s) => s.stage === 'answer')
  const reviews = seats.filter((s) => s.stage === 'review')
  return (
    <div className="council">
      {answers.length > 0 ? (
        <div className="council-stage">
          <div className="council-stage-label">Council · answers</div>
          {answers.map((s) => (
            <CouncilSeatRow key={s.id} seat={s} />
          ))}
        </div>
      ) : null}
      {reviews.length > 0 ? (
        <div className="council-stage">
          <div className="council-stage-label">Peer review</div>
          {reviews.map((s) => (
            <CouncilSeatRow key={s.id} seat={s} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
export const CouncilPanel = memo(CouncilPanelImpl)
