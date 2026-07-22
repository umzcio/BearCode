import { memo, useState } from 'react'
import type { Event, ReviewFinding, ReviewLens } from '@shared/types'
import { useAppStore } from '../../state/store'
import { IconChevronRightSmall } from '../icons'
import './events.css'

type ReviewFindingEvent = Extract<Event, { type: 'review_finding' }>
type ReviewSummaryEvent = Extract<Event, { type: 'review_summary' }>

const SEVERITY_ORDER: Record<ReviewFinding['severity'], number> = {
  critical: 0,
  important: 1,
  minor: 2
}
const SEVERITY_LABEL: Record<ReviewFinding['severity'], string> = {
  critical: 'Critical',
  important: 'Important',
  minor: 'Minor'
}
const LENS_LABEL: Record<ReviewLens, string> = {
  code: 'Code',
  security: 'Security',
  accessibility: 'Accessibility',
  performance: 'Performance',
  comprehensive: 'Comprehensive'
}
const SEVERITIES = ['critical', 'important', 'minor'] as const

// One finding row: severity chip + lens badge + file:line + title, expandable
// to the full detail text. Clicking opens the file in the in-app aux pane at
// the finding's exact line (store's openFileInPane -> Monaco revealLine) and
// toggles the detail open, so the row is a single obvious click target rather
// than two competing ones.
function FindingRow({ finding }: { finding: ReviewFinding }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const openFileInPane = useAppStore((s) => s.openFileInPane)
  const loc = finding.line ? `${finding.file}:${finding.line}` : finding.file

  const activate = (): void => {
    setOpen((o) => !o)
    openFileInPane(finding.file, finding.line)
  }

  return (
    <div className={'finding-row' + (open ? ' open' : '')}>
      <div
        className="finding-head"
        role="button"
        tabIndex={0}
        onClick={activate}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            activate()
          }
        }}
      >
        <span className={`sev-chip sev-${finding.severity}`}>
          {SEVERITY_LABEL[finding.severity]}
        </span>
        <span className="lens-badge">{LENS_LABEL[finding.lens]}</span>
        <span className="finding-loc">{loc}</span>
        <span className="finding-title">{finding.title}</span>
        <span className="chev">
          <IconChevronRightSmall />
        </span>
      </div>
      {open ? <div className="finding-detail">{finding.detail}</div> : null}
    </div>
  )
}

export interface ReviewFindingsProps {
  events: ReviewFindingEvent[]
  summary?: ReviewSummaryEvent
}

// Review mode (Phase H, Task 6): the audit panel's output for a turn --
// findings sorted critical-first (grouped under a per-severity bucket, like
// CouncilPanel groups seats by stage) with a summary header up top once the
// panel concludes (summary arrives after every review_finding for the turn,
// so it renders last visually but first in reading order). Older turns carry
// neither event type, so the panel simply doesn't render.
function ReviewFindingsImpl({ events, summary }: ReviewFindingsProps): React.JSX.Element | null {
  if (events.length === 0 && !summary) return null
  const sorted = [...events].sort(
    (a, b) => SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity]
  )

  return (
    <div className="review-findings">
      <div className="review-findings-head">
        <span className="review-findings-title">Review findings</span>
        {summary ? (
          <span className="review-findings-counts">
            <span className="sev-chip sev-critical">{summary.counts.critical} critical</span>
            <span className="sev-chip sev-important">{summary.counts.important} important</span>
            <span className="sev-chip sev-minor">{summary.counts.minor} minor</span>
          </span>
        ) : null}
      </div>
      {summary?.note ? <div className="review-findings-note">{summary.note}</div> : null}
      {SEVERITIES.map((sev) => {
        const rows = sorted.filter((e) => e.finding.severity === sev)
        if (rows.length === 0) return null
        return (
          <div className="review-sev-group" key={sev}>
            {rows.map((e) => (
              <FindingRow key={e.id} finding={e.finding} />
            ))}
          </div>
        )
      })}
    </div>
  )
}
export const ReviewFindings = memo(ReviewFindingsImpl)
