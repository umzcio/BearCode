import { memo, useState } from 'react'
import type { Event } from '@shared/types'
import { Markdown } from '../../lib/markdown'
import { useAppStore } from '../../state/store'
import { IconChevronRightSmall } from '../icons'
import './events.css'

type ArtifactEvent = Extract<Event, { type: 'artifact' }>

export const ARTIFACT_TYPE_LABELS = {
  plan: 'Implementation Plan',
  walkthrough: 'Walkthrough'
} as const

export const ARTIFACT_STATUS_LABELS = {
  'pending-review': 'pending review',
  approved: 'approved',
  superseded: 'superseded',
  final: 'final'
} as const

// Read-only transcript card for a plan/walkthrough artifact (Ba1). The header
// toggles the inline body; "Open in pane" shows it in the artifacts pane.
// SECURITY (design section 4): the body renders through the SAME sanitized
// markdown pipeline as chat prose (lib/markdown.tsx: no raw HTML ever touches
// the DOM). Proceed/Review actions and comments arrive with Ba2; this card
// only displays.
function ArtifactCardImpl({ event }: { event: ArtifactEvent }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const openArtifactPane = useAppStore((s) => s.openArtifactPane)
  return (
    <div className={'artifact-card' + (open ? ' open' : '')}>
      <div className="artifact-head" onClick={() => setOpen((o) => !o)}>
        <span className="artifact-kind">{ARTIFACT_TYPE_LABELS[event.artifactType]}</span>
        <span className="artifact-title">{event.title}</span>
        <span className="artifact-version">v{event.version}</span>
        <span className={'artifact-status ' + event.status}>
          {ARTIFACT_STATUS_LABELS[event.status]}
        </span>
        <button
          className="artifact-pane-btn"
          onClick={(e) => {
            e.stopPropagation()
            openArtifactPane(event.artifactId)
          }}
        >
          Open in pane
        </button>
        <span className="chev">
          <IconChevronRightSmall />
        </span>
      </div>
      {open ? (
        <div className="artifact-body">
          <Markdown text={event.body} />
        </div>
      ) : null}
    </div>
  )
}
export const ArtifactCard = memo(ArtifactCardImpl)
