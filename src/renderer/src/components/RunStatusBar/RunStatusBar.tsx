import { useEffect, useState } from 'react'
import { useAppStore } from '../../state/store'
import { deriveActivity, formatElapsed } from '../../lib/activity'
import { ThinkingPaw } from '../brand/ThinkingPaw'
import './RunStatusBar.css'

export function RunStatusBar({
  convoId,
  onJumpToApproval
}: {
  convoId: string
  onJumpToApproval: () => void
}): React.JSX.Element | null {
  const runState = useAppStore((s) => s.conversations[convoId]?.runState)
  const events = useAppStore((s) => s.conversations[convoId]?.events)
  const startedAt = useAppStore((s) => s.conversations[convoId]?.startedAt)
  const cancelRun = useAppStore((s) => s.cancelRun)
  const [elapsed, setElapsed] = useState(0)

  const active = runState === 'running' || runState === 'awaiting-approval'

  useEffect(() => {
    if (!active || !startedAt) return undefined
    const tick = (): void => setElapsed(Math.round((Date.now() - startedAt) / 1000))
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [active, startedAt])

  if (!active || !runState) return null

  const activity = deriveActivity(runState, events ?? [])
  const attention = activity.tone === 'attention'

  return (
    <div
      className={'run-status-bar' + (attention ? ' attention' : '')}
      onClick={attention ? onJumpToApproval : undefined}
      onKeyDown={
        attention
          ? (e): void => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onJumpToApproval()
              }
            }
          : undefined
      }
      role={attention ? 'button' : undefined}
      tabIndex={attention ? 0 : undefined}
    >
      {attention ? <span className="rsb-dot" /> : <ThinkingPaw size={17} />}
      <span className="rsb-label">{activity.label}</span>
      {startedAt ? <span className="rsb-elapsed">{formatElapsed(elapsed)}</span> : null}
      <button
        className="rsb-stop"
        title="Stop"
        onClick={(e) => {
          e.stopPropagation()
          cancelRun(convoId)
        }}
      >
        Stop
      </button>
    </div>
  )
}
