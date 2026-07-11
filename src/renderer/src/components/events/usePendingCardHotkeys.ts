import { useEffect } from 'react'

interface UsePendingCardHotkeysOpts {
  active: boolean
  onApprove: () => void
  onDeny: () => void
  onAlways?: () => void
}

// Shared number-key hotkey scheme for the pending approval cards (extracted
// from the 8 hand-duplicated inline useEffects across ToolStep.tsx's Pending*
// components, audit L-17). Only the FIRST pending card in the conversation
// (isFirst / `active`) is hotkey-live, so one keypress never answers more
// than one card in a batch of parallel approvals.
//
// Key mapping matches the pre-existing inline contract exactly:
//   '1' -> onApprove
//   an "always allow" card (onAlways passed): '2' -> onAlways, '3' -> onDeny
//   a plain allow/deny card (onAlways omitted): '2' -> onDeny
// Modifier-held presses and presses while focus is in a text field are
// ignored so hotkeys never fire while the user is typing elsewhere.
export function usePendingCardHotkeys({
  active,
  onApprove,
  onDeny,
  onAlways
}: UsePendingCardHotkeysOpts): void {
  useEffect(() => {
    if (!active) return undefined
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === '1') {
        onApprove()
      } else if (onAlways) {
        if (e.key === '2') onAlways()
        else if (e.key === '3') onDeny()
      } else if (e.key === '2') {
        onDeny()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, onApprove, onDeny, onAlways])
}
