import { useAppStore } from '../../state/store'
import { deriveActivity } from '../../lib/activity'
import { useAnimatedUnmount } from '../../lib/useAnimatedUnmount'
import './RunStatusBar.css'

// Attention-only bar: while a run is merely working, the transcript's
// WorkedGroup header is the single live "Working…" indicator and the
// composer's send button morphs into Stop (Composer.tsx `running`), so this
// bar stays hidden. It appears only when the run is blocked on the user
// (awaiting approval) and acts as a jump-to-approval affordance.
// Consolidation decision: docs/superpowers/specs/2026-08-12-beautiful-ui-overhaul-design.md follow-up.
export function RunStatusBar({
  convoId,
  onJumpToApproval
}: {
  convoId: string
  onJumpToApproval: () => void
}): React.JSX.Element | null {
  const runState = useAppStore((s) => s.conversations[convoId]?.runState)
  const events = useAppStore((s) => s.conversations[convoId]?.events)

  const show = runState === 'awaiting-approval'
  // durationMs must match .run-status-bar's own CSS transition duration
  // (--dur-fast, RunStatusBar.css).
  const { mounted, state } = useAnimatedUnmount(show, { durationMs: 150 })

  // The `!runState` guard covers runState clearing mid-exit -- the bar just unmounts.
  if (!mounted || !runState) return null

  const activity = deriveActivity(runState, events ?? [])
  const planReview = activity.label === 'Waiting for plan review'

  return (
    <div
      className="run-status-bar attention"
      data-state={state}
      onClick={onJumpToApproval}
      onKeyDown={(e): void => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onJumpToApproval()
        }
      }}
      role="button"
      tabIndex={0}
    >
      <span className="rsb-dot" />
      <span className="rsb-label">{activity.label}</span>
      <span className="rsb-view">{planReview ? 'View plan →' : 'View →'}</span>
    </div>
  )
}
