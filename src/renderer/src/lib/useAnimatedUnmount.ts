import { useEffect, useState } from 'react'

// Matches --dur-modal in styles/tokens.css.
const DEFAULT_DURATION_MS = 220

interface InternalState {
  open: boolean
  mounted: boolean
  phase: 'open' | 'closing'
}

// Keeps a conditionally-rendered element mounted through its exit transition.
// Returns whether to render, and the state to drive CSS ([data-state]).
export function useAnimatedUnmount(
  open: boolean,
  opts?: { durationMs?: number }
): { mounted: boolean; state: 'open' | 'closing' } {
  const durationMs = opts?.durationMs ?? DEFAULT_DURATION_MS
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
      // Under reduced motion, skip the exit transition and unmount now.
      // (matchMedia is absent in some test/non-browser environments -- treat
      // that as "not reduced" rather than throwing.)
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false
      setS({ open, mounted: !reduce, phase: 'closing' })
    }
  }

  // Genuine side effect: schedule the deferred unmount for the animated
  // (non-reduced-motion) closing case. The setState that follows lives
  // inside the timer callback, not the effect body.
  useEffect(() => {
    if (s.phase !== 'closing' || !s.mounted) return
    const id = window.setTimeout(() => {
      setS((prev) => (prev.phase === 'closing' ? { ...prev, mounted: false } : prev))
    }, durationMs)
    return () => window.clearTimeout(id)
  }, [s.phase, s.mounted, durationMs])

  return { mounted: s.mounted, state: s.phase }
}
