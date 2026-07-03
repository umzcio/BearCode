import { useState } from 'react'
import { Markdown } from '../../lib/markdown'
import { IconChevronRightSmall } from '../icons'
import './events.css'

export function ThinkingStep({
  text,
  durationMs
}: {
  text: string
  durationMs: number
}): React.JSX.Element {
  // Reasoning is part of the show: expanded by default, collapsible.
  const [open, setOpen] = useState(true)
  const secs = Math.max(1, Math.round(durationMs / 1000))
  return (
    <div className={'step' + (open ? ' open' : '')}>
      <div className="step-row" onClick={() => setOpen((o) => !o)}>
        <span>
          Thought for <b>{secs}s</b>
        </span>
        <span className="chev">
          <IconChevronRightSmall />
        </span>
      </div>
      <div className="step-body md">
        <Markdown text={text} />
      </div>
    </div>
  )
}
