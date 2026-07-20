import { memo, useEffect, useState } from 'react'
import type { Event } from '@shared/types'
import { subagentLabel } from '@shared/agentId'
import { formatElapsed } from '../../lib/activity'
import { ThinkingPaw } from '../brand/ThinkingPaw'
import { IconChevronDown } from '../icons'
import { ThinkingStep } from './ThinkingStep'
import { ToolStep } from './ToolStep'
import { UrsaStepDivider } from './UrsaStepDivider'
import './events.css'

interface WorkedGroupProps {
  steps: Event[]
  live: boolean
  startedAt?: number
  workedSeconds?: number
  convoId: string
}

// Absent/'main' agentId means the primary agent; a subagent's steps get a
// small pill so multi-agent output is visibly attributed without a full
// multi-agent UI.
function AgentAttributed({
  event,
  children
}: {
  event: Event
  children: React.ReactNode
}): React.JSX.Element {
  const label = subagentLabel(event)
  if (!label) return <>{children}</>
  return (
    <div className="agent-attributed">
      <span className="agent-pill">{label}</span>
      {children}
    </div>
  )
}

function WorkedGroupImpl({
  steps,
  live,
  startedAt,
  workedSeconds,
  convoId
}: WorkedGroupProps): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!live || !startedAt) return undefined
    const tick = (): void => setElapsed(Math.round((Date.now() - startedAt) / 1000))
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [live, startedAt])

  // Same formatter the RunStatusBar uses (lib/activity formatElapsed) so the
  // two live timers can never disagree ("89s" vs "1:06" -- a live complaint).
  const label = live
    ? `Working…${elapsed > 0 ? ` ${formatElapsed(elapsed)}` : ''}`
    : `Worked for ${formatElapsed(workedSeconds ?? 1)}`

  // Pair each tool_call with its tool_result; thinking renders on its own.
  const resultsByCallId = new Map<string, Extract<Event, { type: 'tool_result' }>>()
  for (const ev of steps) {
    if (ev.type === 'tool_result') resultsByCallId.set(ev.callId, ev)
  }

  const rows: React.JSX.Element[] = []
  for (let i = 0; i < steps.length; i++) {
    const ev = steps[i]
    if (ev.type === 'ursa_step') {
      rows.push(<UrsaStepDivider key={ev.id} event={ev} />)
    } else if (ev.type === 'thinking') {
      rows.push(
        <AgentAttributed key={ev.id} event={ev}>
          <ThinkingStep text={ev.text} durationMs={ev.durationMs} />
        </AgentAttributed>
      )
    } else if (ev.type === 'tool_call') {
      const result = resultsByCallId.get(ev.id)
      // F1 jump-to-match anchor: a content-search hit can land on the tool_call
      // OR its tool_result (both are FTS-indexed via extractSearchText), yet the
      // pair renders as one ToolStep. So the wrapper advertises BOTH event ids,
      // space-joined -- ConversationView's focus scan matches either id. Without
      // this, tool/tool_result hits jump nowhere (their rows had no data-event-id).
      const anchorIds = result && result.type === 'tool_result' ? `${ev.id} ${result.id}` : ev.id
      rows.push(
        <div key={ev.id} data-event-id={anchorIds}>
          <AgentAttributed event={ev}>
            <ToolStep
              call={ev}
              result={result && result.type === 'tool_result' ? result : undefined}
              convoId={convoId}
            />
          </AgentAttributed>
        </div>
      )
    }
  }

  return (
    <>
      <div
        className={'worked-head' + (collapsed ? ' collapsed-state' : '')}
        onClick={() => setCollapsed((c) => !c)}
      >
        {live ? <ThinkingPaw size={17} /> : null}
        <span>{label}</span>
        <span className="chev">
          <IconChevronDown />
        </span>
      </div>
      <div className={'steps' + (collapsed ? ' collapsed' : '')}>{rows}</div>
    </>
  )
}
export const WorkedGroup = memo(WorkedGroupImpl)
