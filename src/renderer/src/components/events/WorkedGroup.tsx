import { useEffect, useState } from 'react'
import type { Event } from '@shared/types'
import { ThinkingPaw } from '../brand/ThinkingPaw'
import { PixelBear } from '../brand/PixelBear'
import { IconChevronDown } from '../icons'
import { ThinkingStep } from './ThinkingStep'
import { ToolStep } from './ToolStep'
import './events.css'

interface WorkedGroupProps {
  steps: Event[]
  live: boolean
  startedAt?: number
  workedSeconds?: number
  showBear: boolean
  convoId: string
}

// Mirrors src/main/orchestrator/agentId.ts#subagentLabel. Kept as a small
// inline copy since the renderer's tsconfig doesn't include src/main.
function subagentLabel(agentId?: string): string | null {
  if (!agentId || agentId === 'main') return null
  return agentId
}

// Absent/'main' agentId means the primary agent; a subagent's steps get a
// small pill so multi-agent output is visibly attributed without a full
// multi-agent UI.
function AgentAttributed({
  agentId,
  children
}: {
  agentId?: string
  children: React.ReactNode
}): React.JSX.Element {
  const label = subagentLabel(agentId)
  if (!label) return <>{children}</>
  return (
    <div className="agent-attributed">
      <span className="agent-pill">{label}</span>
      {children}
    </div>
  )
}

export function WorkedGroup({
  steps,
  live,
  startedAt,
  workedSeconds,
  showBear,
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

  const label = live
    ? `Working…${elapsed > 0 ? ` ${elapsed}s` : ''}`
    : `Worked for ${workedSeconds ?? 1}s`

  // Pair each tool_call with its tool_result; thinking renders on its own.
  const rows: React.JSX.Element[] = []
  for (let i = 0; i < steps.length; i++) {
    const ev = steps[i]
    if (ev.type === 'thinking') {
      rows.push(
        <AgentAttributed key={ev.id} agentId={ev.agentId}>
          <ThinkingStep text={ev.text} durationMs={ev.durationMs} />
        </AgentAttributed>
      )
    } else if (ev.type === 'tool_call') {
      const result = steps.find((r) => r.type === 'tool_result' && r.callId === ev.id)
      rows.push(
        <AgentAttributed key={ev.id} agentId={ev.agentId}>
          <ToolStep
            call={ev}
            result={result && result.type === 'tool_result' ? result : undefined}
            convoId={convoId}
          />
        </AgentAttributed>
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
      <div className={'steps' + (collapsed ? ' collapsed' : '')}>
        {rows}
        {showBear ? (
          <div className="bear-amble">
            <PixelBear scale={3} />
          </div>
        ) : null}
      </div>
    </>
  )
}
