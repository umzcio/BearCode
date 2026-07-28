import { useCallback, useEffect, useState } from 'react'
import { prefersReducedMotion } from './prefersReducedMotion'

// Matches --dur-modal in styles/tokens.css.
const DEFAULT_DURATION_MS = 220
const SIGNAL_FAILSAFE_MS = 2000

interface AnimatedUnmountOptions {
  durationMs?: number
  immediate?: boolean
  exitCompletion?: 'timer' | 'signal'
}

interface AnimatedUnmountResult {
  mounted: boolean
  state: 'open' | 'closing'
  completeExit: () => void
}

interface InternalState {
  open: boolean
  mounted: boolean
  phase: 'open' | 'closing'
}

// Keeps a conditionally-rendered element mounted through its exit transition.
// Returns whether to render, and the state to drive CSS ([data-state]).
export function useAnimatedUnmount(
  open: boolean,
  opts?: AnimatedUnmountOptions
): AnimatedUnmountResult {
  const durationMs = opts?.durationMs ?? DEFAULT_DURATION_MS
  const immediate = opts?.immediate ?? false
  const exitCompletion = opts?.exitCompletion ?? 'timer'
  const [s, setS] = useState<InternalState>(() => ({ open, mounted: open, phase: 'open' }))

  // Adjust state during render when `open` flips -- the React-endorsed
  // "adjust state during render" pattern (not an effect): it re-renders
  // synchronously before paint instead of a separate commit, and only fires
  // on the open<->closed edge. See
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  if (open !== s.open) {
    if (open) {
      setS({ open, mounted: true, phase: 'open' })
    } else {
      // Under reduced motion (OS signal OR the in-app data-motion="reduced"
      // toggle -- see prefersReducedMotion.ts), skip the exit transition and
      // unmount now instead of waiting for a CSS transition that tokens.css
      // has already collapsed to ~0 under the in-app toggle.
      const skipExit = immediate || prefersReducedMotion()
      setS({ open, mounted: !skipExit, phase: 'closing' })
    }
  }

  const completeExit = useCallback(() => {
    setS((prev) =>
      prev.phase === 'closing' && prev.mounted ? { ...prev, mounted: false } : prev
    )
  }, [])

  // Genuine side effect: timer mode defines an existing consumer's visible
  // duration. Signal mode only uses a conservative fail-safe so a missing
  // platform transition event cannot retain the element indefinitely.
  useEffect(() => {
    if (s.phase !== 'closing' || !s.mounted) return
    const waitMs = exitCompletion === 'signal' ? SIGNAL_FAILSAFE_MS : durationMs
    const id = window.setTimeout(completeExit, waitMs)
    return () => window.clearTimeout(id)
  }, [completeExit, durationMs, exitCompletion, s.mounted, s.phase])

  return { mounted: s.mounted, state: s.phase, completeExit }
}
