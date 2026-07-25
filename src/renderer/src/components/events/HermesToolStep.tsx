import { useRef, useState } from 'react'
import type { ApprovalDecision, Event } from '@shared/types'
import { useAppStore } from '../../state/store'
import './events.css'

type HermesToolCall = Extract<Event, { type: 'hermes_tool_call' }>
type HermesToolResult = Extract<Event, { type: 'hermes_tool_result' }>

export interface HermesToolStepProps {
  call: HermesToolCall
  result?: HermesToolResult
  convoId: string
  interactive?: boolean
}

function durationLabel(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`
  const seconds = durationMs / 1000
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`
}

export function HermesToolStep({
  call,
  result,
  convoId,
  interactive = false
}: HermesToolStepProps): React.JSX.Element {
  const resolveHermesApproval = useAppStore((state) => state.resolveHermesApproval)
  const submittedRef = useRef(false)
  const [submitted, setSubmitted] = useState(false)
  const status = result?.status ?? call.status
  const statusText =
    status === 'awaiting-approval'
      ? 'Awaiting approval'
      : status === 'completed'
        ? 'Completed'
        : status === 'failed'
          ? 'Failed'
          : 'Running'
  const decisions: Array<{ decision: ApprovalDecision; label: string }> = [
    { decision: 'once', label: 'Allow Once' },
    ...(call.allowSession ? [{ decision: 'session' as const, label: 'Allow Session' }] : []),
    ...(call.allowPermanent ? [{ decision: 'always' as const, label: 'Always Allow' }] : []),
    { decision: 'deny', label: 'Deny' }
  ]

  const decide = (decision: ApprovalDecision): void => {
    if (!interactive || submittedRef.current || !call.requestId) return
    submittedRef.current = true
    setSubmitted(true)
    resolveHermesApproval(convoId, call.requestId, decision)
  }

  return (
    <div className="step">
      <div className="step-row static">
        <span>
          <b>{call.label}</b> <span className="sandbox-badge">{call.name}</span>
        </span>
        <span>
          {statusText}
          {result ? ` · ${durationLabel(result.durationMs)}` : ''}
        </span>
      </div>
      {status === 'awaiting-approval' ? (
        <>
          <div className="waiting-note">Waiting for your approval…</div>
          <div
            className="approval-card pulse-once"
            id={interactive ? 'pending-approval-card' : undefined}
          >
            <div className="approval-title">{call.description ?? call.label}</div>
            {call.command ? <pre className="approval-cmd">{call.command}</pre> : null}
            {interactive && call.requestId ? (
              <div className="approval-actions" role="group" aria-label={`${call.label} approval`}>
                {decisions.map(({ decision, label }) => (
                  <button
                    key={decision}
                    type="button"
                    className="pill-btn"
                    disabled={submitted}
                    onClick={() => decide(decision)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  )
}
