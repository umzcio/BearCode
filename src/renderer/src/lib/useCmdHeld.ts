import { useEffect, useState } from 'react'

// True while Cmd (metaKey) or Ctrl is held. Used to reveal the Cmd-click "open
// file" affordance (E10). Resets on blur so a modifier released off-window
// doesn't stick.
export function useCmdHeld(): boolean {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey) setHeld(true)
    }
    const up = (e: KeyboardEvent): void => {
      if (!e.metaKey && !e.ctrlKey) setHeld(false)
    }
    const clear = (): void => setHeld(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', clear)
    }
  }, [])
  return held
}
