import { memo, useEffect, useState } from 'react'
import type { Event } from '@shared/types'
import { subagentLabel } from '@shared/agentId'
import { formatElapsed } from '../../lib/activity'
import { ThinkingPaw } from '../brand/ThinkingPaw'
import { ChevronDown } from 'lucide-react'
import { ThinkingStep } from './ThinkingStep'
import { ToolStep } from './ToolStep'
import { HermesToolStep, HermesUnmatchedResult } from './HermesToolStep'
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
  // BUI cascade (ToolChips/TaskRows): rows entering a LIVE run fade-up with an
  // 80ms stagger. Each row key is assigned its position WITHIN ITS MOUNT BATCH
  // exactly once (capped at 6) and keeps it forever, so a re-render can never
  // re-animate an already-settled row, and a row streaming in alone gets no
  // artificial delay. Historical (non-live) renders never animate at all.
  // Held in useState (never set) so the memo cache is render-readable; an
  // already-assigned key is a no-op on StrictMode's double render.
  const [enterIndex] = useState(() => new Map<string, number>())

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
  const hermesCallsById = new Map<string, Extract<Event, { type: 'hermes_tool_call' }>[]>()
  const hermesResultsByCallId = new Map<string, Extract<Event, { type: 'hermes_tool_result' }>[]>()
  for (const ev of steps) {
    if (ev.type === 'tool_result') resultsByCallId.set(ev.callId, ev)
    if (ev.type === 'hermes_tool_call') {
      const calls = hermesCallsById.get(ev.id) ?? []
      calls.push(ev)
      hermesCallsById.set(ev.id, calls)
    }
    if (ev.type === 'hermes_tool_result') {
      const results = hermesResultsByCallId.get(ev.callId) ?? []
      results.push(ev)
      hermesResultsByCallId.set(ev.callId, results)
    }
  }

  const rows: { key: string; node: React.JSX.Element }[] = []
  for (let i = 0; i < steps.length; i++) {
    const ev = steps[i]
    if (ev.type === 'ursa_step') {
      rows.push({ key: ev.id, node: <UrsaStepDivider event={ev} /> })
    } else if (ev.type === 'thinking') {
      rows.push({
        key: ev.id,
        node: (
          <AgentAttributed event={ev}>
            <ThinkingStep text={ev.text} durationMs={ev.durationMs} />
          </AgentAttributed>
        )
      })
    } else if (ev.type === 'tool_call') {
      const result = resultsByCallId.get(ev.id)
      // F1 jump-to-match anchor: a content-search hit can land on the tool_call
      // OR its tool_result (both are FTS-indexed via extractSearchText), yet the
      // pair renders as one ToolStep. So the wrapper advertises BOTH event ids,
      // space-joined -- ConversationView's focus scan matches either id. Without
      // this, tool/tool_result hits jump nowhere (their rows had no data-event-id).
      const anchorIds = result && result.type === 'tool_result' ? `${ev.id} ${result.id}` : ev.id
      rows.push({
        key: ev.id,
        node: (
          <div data-event-id={anchorIds}>
            <AgentAttributed event={ev}>
              <ToolStep
                call={ev}
                result={result && result.type === 'tool_result' ? result : undefined}
                convoId={convoId}
              />
            </AgentAttributed>
          </div>
        )
      })
    } else if (ev.type === 'hermes_tool_call') {
      const calls = hermesCallsById.get(ev.id) ?? []
      const results = hermesResultsByCallId.get(ev.id) ?? []
      const result = calls.length === 1 && results.length === 1 ? results[0] : undefined
      const anchorIds = result ? `${ev.id} ${result.id}` : ev.id
      rows.push({
        key: `${ev.id}:${i}`,
        node: (
          <div data-event-id={anchorIds}>
            <AgentAttributed event={ev}>
              <HermesToolStep call={ev} result={result} convoId={convoId} />
            </AgentAttributed>
          </div>
        )
      })
    } else if (ev.type === 'hermes_tool_result') {
      const calls = hermesCallsById.get(ev.callId) ?? []
      const results = hermesResultsByCallId.get(ev.callId) ?? []
      if (calls.length === 1 && results.length === 1) continue
      rows.push({
        key: `${ev.id}:${i}`,
        node: (
          <div data-event-id={ev.id}>
            <AgentAttributed event={ev}>
              <HermesUnmatchedResult result={ev} />
            </AgentAttributed>
          </div>
        )
      })
    }
  }

  // Assign each new key its position within this render's mount batch. Called
  // in row order below, so a batch that mounts together cascades 0..6.
  let newInBatch = 0
  const staggerFor = (key: string): number => {
    const assigned = enterIndex.get(key)
    if (assigned !== undefined) return assigned
    const idx = Math.min(newInBatch, 6)
    newInBatch += 1
    enterIndex.set(key, idx)
    return idx
  }

  return (
    <>
      <div
        className={'worked-head' + (collapsed ? ' collapsed-state' : '')}
        onClick={() => setCollapsed((c) => !c)}
      >
        {live ? <ThinkingPaw size={17} /> : null}
        {/* BUI ThinkingState: the active label shimmers; settled text is plain. */}
        <span className={live ? 'shimmer-label' : undefined}>{label}</span>
        <span className="chev">
          <ChevronDown />
        </span>
      </div>
      {/* BUI collapsible grammar: the grid wrapper animates 0fr<->1fr while the
          inner .steps clips — no display:none snap. */}
      <div className={'steps-reveal' + (collapsed ? ' collapsed' : '')}>
        <div className={'steps' + (live ? ' live' : '')}>
          {rows.map(({ key, node }) =>
            live ? (
              <div
                key={key}
                className="step-enter"
                style={{ '--i': staggerFor(key) } as React.CSSProperties}
              >
                {node}
              </div>
            ) : (
              <div key={key}>{node}</div>
            )
          )}
        </div>
      </div>
    </>
  )
}
export const WorkedGroup = memo(WorkedGroupImpl)
