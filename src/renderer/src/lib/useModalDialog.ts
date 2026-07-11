import { useEffect, useRef } from 'react'

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

export function useModalDialog(onClose: () => void): {
  ref: React.RefObject<HTMLDivElement | null>
  dialogProps: { role: 'dialog'; 'aria-modal': true; tabIndex: -1 }
} {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const panel = ref.current
    if (!panel) return
    const opener = document.activeElement as HTMLElement | null
    // Note: `offsetParent !== null` is the usual "is this visible" check, but jsdom
    // (our test environment) never computes layout, so offsetParent is always null
    // there — that would filter out every element and break the trap under test.
    // getComputedStyle(...).display works in both jsdom and real browsers.
    const focusables = (): HTMLElement[] =>
      Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => getComputedStyle(el).display !== 'none'
      )
    // Initial focus: first focusable, else the panel itself.
    const first = focusables()[0]
    ;(first ?? panel).focus()

    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) {
        e.preventDefault()
        panel.focus()
        return
      }
      const firstEl = items[0]
      const lastEl = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === firstEl || active === panel)) {
        e.preventDefault()
        lastEl.focus()
      } else if (!e.shiftKey && active === lastEl) {
        e.preventDefault()
        firstEl.focus()
      }
    }
    panel.addEventListener('keydown', onKey)
    return () => {
      panel.removeEventListener('keydown', onKey)
      opener?.focus?.() // restore focus to the opener
    }
  }, [onClose])

  return { ref, dialogProps: { role: 'dialog', 'aria-modal': true, tabIndex: -1 } }
}
