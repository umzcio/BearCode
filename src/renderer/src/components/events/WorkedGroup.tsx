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
}

export function WorkedGroup({
  steps,
  live,
  startedAt,
  workedSeconds,
  showBear
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
      rows.push(<ThinkingStep key={ev.id} text={ev.text} durationMs={ev.durationMs} />)
    } else if (ev.type === 'tool_call') {
      const result = steps.find((r) => r.type === 'tool_result' && r.callId === ev.id)
      rows.push(
        <ToolStep
          key={ev.id}
          call={ev}
          result={result && result.type === 'tool_result' ? result : undefined}
        />
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
