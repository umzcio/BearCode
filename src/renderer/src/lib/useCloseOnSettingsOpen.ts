import { useEffect, useRef } from 'react'

// Composer popovers (Ursa Mode/Model/Effort/Permission Mode pickers) each own
// a local `open` boolean, dismissed by the shared Popover primitive's own
// click-outside/Esc/scroll handlers. None of those fire when Settings opens
// via the global Cmd+, shortcut (App.tsx calls store.openSettings() directly,
// bypassing every popover's dismissal path), so a picker left open before
// Settings opens stays mounted and renders on top of it. Call this from any
// such component to close it the moment Settings opens.
//
// Deliberately does NOT import useAppStore itself (unlike ui/ primitives and
// other lib/ hooks, which stay store-agnostic and take values as parameters
// -- see useModalDialog.ts) -- callers subscribe to `settingsOpen` themselves
// and pass it in.
export function useCloseOnSettingsOpen(
  open: boolean,
  settingsOpen: boolean,
  onClose: () => void
): void {
  // Track the previous settingsOpen value so this only fires on the
  // false -> true EDGE, never merely because settingsOpen started (or
  // stayed) true while this popover happened to mount/re-render -- calling
  // onClose() on every render where both are true would fight a caller that
  // legitimately wants to open its own popover while Settings is already up.
  const wasSettingsOpen = useRef(settingsOpen)
  useEffect(() => {
    const edge = settingsOpen && !wasSettingsOpen.current
    wasSettingsOpen.current = settingsOpen
    if (open && edge) onClose()
  }, [open, settingsOpen, onClose])
}
