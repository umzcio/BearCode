import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './Hint.css'

const INITIAL_HINT_DELAY_MS = 450
const HINT_WARM_WINDOW_MS = 800
let hintWarmUntil = 0

// Test-only reset to prevent shared module state leaking between test cases.
export function resetHintWarmStateForTests(): void {
  hintWarmUntil = 0
}

interface HintProps {
  label: string
  keys?: string
  side?: 'bottom' | 'right' | 'top'
  disabled?: boolean
  children: React.ReactNode
}

interface HintPos {
  x: number
  y: number
  animated: boolean
}

type HintOrigin = 'focus' | 'pointer'

// Hover tooltip with an optional keyboard-shortcut hint, rendered through a
// portal so it never clips inside the sidebar or composer.
export function Hint({
  label,
  keys,
  side = 'bottom',
  disabled = false,
  children
}: HintProps): React.JSX.Element {
  const [pos, setPos] = useState<HintPos | null>(null)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const timer = useRef<number | undefined>(undefined)
  const disabledRef = useRef(disabled)
  const visibleOriginRef = useRef<HintOrigin | null>(null)

  disabledRef.current = disabled

  useEffect(
    () => () => {
      window.clearTimeout(timer.current)
      if (visibleOriginRef.current === 'pointer') {
        hintWarmUntil = Date.now() + HINT_WARM_WINDOW_MS
      }
    },
    []
  )

  useEffect(() => {
    if (disabled) {
      window.clearTimeout(timer.current)
      if (visibleOriginRef.current === 'pointer') {
        hintWarmUntil = Date.now() + HINT_WARM_WINDOW_MS
      }
      visibleOriginRef.current = null
      setPos(null)
    }
  }, [disabled])

  const reveal = (origin: HintOrigin, animated: boolean): void => {
    if (disabledRef.current) return
    const rect = wrapRef.current?.firstElementChild?.getBoundingClientRect()
    if (!rect) return
    // The app sets CSS `zoom` on <html> for font size (appearance.ts). A
    // position:fixed bubble is re-scaled by that zoom, while getBoundingClientRect
    // already returns zoom-scaled coords -- so a raw rect lands the bubble at
    // position*zoom^2. Divide by the zoom factor so it sits exactly under the
    // trigger regardless of font-size setting (mirrors Select.tsx).
    const zoom = Number(document.documentElement.style.zoom) || 1
    if (side === 'right')
      setPos({
        x: rect.right / zoom + 10,
        y: rect.top / zoom + rect.height / zoom / 2,
        animated
      })
    else if (side === 'top')
      setPos({
        x: rect.left / zoom + rect.width / zoom / 2,
        y: rect.top / zoom - 8,
        animated
      })
    else
      setPos({
        x: rect.left / zoom + rect.width / zoom / 2,
        y: rect.bottom / zoom + 8,
        animated
      })
    visibleOriginRef.current = origin
    if (origin === 'pointer') hintWarmUntil = Date.now() + HINT_WARM_WINDOW_MS
  }

  const canHoverWithFinePointer = (): boolean =>
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(hover: hover) and (pointer: fine)').matches

  const showPointer = (): void => {
    if (disabled || !canHoverWithFinePointer()) return
    window.clearTimeout(timer.current)
    if (Date.now() < hintWarmUntil) reveal('pointer', false)
    else
      timer.current = window.setTimeout(() => {
        if (canHoverWithFinePointer()) reveal('pointer', true)
      }, INITIAL_HINT_DELAY_MS)
  }

  const showFocus = (): void => {
    if (disabled) return
    window.clearTimeout(timer.current)
    reveal('focus', false)
  }

  const hide = (): void => {
    window.clearTimeout(timer.current)
    if (visibleOriginRef.current === 'pointer') {
      hintWarmUntil = Date.now() + HINT_WARM_WINDOW_MS
    }
    visibleOriginRef.current = null
    setPos(null)
  }

  return (
    <span
      className="hint-wrap"
      ref={wrapRef}
      onMouseEnter={showPointer}
      onMouseLeave={hide}
      onMouseDown={hide}
      onFocus={showFocus}
      onBlur={hide}
    >
      {children}
      {pos && !disabled
        ? createPortal(
            <div className={'hint-bubble ' + side} style={{ left: pos.x, top: pos.y }}>
              <div className={'hint-surface' + (pos.animated ? ' hint-enter' : '')}>
                {label}
                {keys ? <span className="hint-keys">{keys}</span> : null}
              </div>
            </div>,
            document.body
          )
        : null}
    </span>
  )
}
