import { useRef, useState } from 'react'
import type { ApprovalDecision, Event } from '@shared/types'
import { useAppStore } from '../../state/store'
import { useAnimatedUnmount } from '../../lib/useAnimatedUnmount'
import './events.css'

type HermesToolCall = Extract<Event, { type: 'hermes_tool_call' }>
type HermesToolResult = Extract<Event, { type: 'hermes_tool_result' }>

export interface HermesToolStepProps {
  call: HermesToolCall
  result?: HermesToolResult
  convoId: string
  interactive?: boolean
}

export function hermesDurationLabel(durationMs: number): string {
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
  const [submitError, setSubmitError] = useState<string | null>(null)
  const status = result?.status ?? call.status
  const { mounted: approvalMounted, state: approvalState } = useAnimatedUnmount(
    status === 'awaiting-approval'
  )
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
    setSubmitError(null)
    void resolveHermesApproval(convoId, call.requestId, decision).catch(() => {
      submittedRef.current = false
      setSubmitted(false)
      setSubmitError('Could not submit approval. Try again.')
    })
  }

  return (
    <div className="step">
      <div className="step-row static">
        <span>
          <b>{call.label}</b> <span className="sandbox-badge">{call.name}</span>
        </span>
        <span>
          {statusText}
          {result ? ` · ${hermesDurationLabel(result.durationMs)}` : ''}
        </span>
      </div>
      {approvalMounted ? (
        <>
          <div className="waiting-note">Waiting for your approval…</div>
          <div
            className="approval-card pulse-once"
            data-state={approvalState}
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
            {submitError ? (
              <div className="waiting-note" role="alert">
                {submitError}
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  )
}

export function HermesUnmatchedResult({
  result
}: {
  result: HermesToolResult
}): React.JSX.Element {
  const status = result.status === 'completed' ? 'Completed' : 'Failed'
  return (
    <div className="step">
      <div className="step-row static">
        <span>
          <b>Unmatched Hermes result</b>
        </span>
        <span>
          {status} · {hermesDurationLabel(result.durationMs)}
        </span>
      </div>
    </div>
  )
}
