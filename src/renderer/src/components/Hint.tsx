import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './Hint.css'

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
}

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

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const show = (): void => {
    if (disabled) return
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const rect = wrapRef.current?.firstElementChild?.getBoundingClientRect()
      if (!rect) return
      // The app sets CSS `zoom` on <html> for font size (appearance.ts). A
      // position:fixed bubble is re-scaled by that zoom, while getBoundingClientRect
      // already returns zoom-scaled coords -- so a raw rect lands the bubble at
      // position*zoom^2. Divide by the zoom factor so it sits exactly under the
      // trigger regardless of font-size setting (mirrors Select.tsx).
      const zoom = Number(document.documentElement.style.zoom) || 1
      if (side === 'right')
        setPos({ x: rect.right / zoom + 10, y: rect.top / zoom + rect.height / zoom / 2 })
      else if (side === 'top')
        setPos({ x: rect.left / zoom + rect.width / zoom / 2, y: rect.top / zoom - 8 })
      else setPos({ x: rect.left / zoom + rect.width / zoom / 2, y: rect.bottom / zoom + 8 })
    }, 450)
  }

  const hide = (): void => {
    window.clearTimeout(timer.current)
    setPos(null)
  }

  return (
    <span
      className="hint-wrap"
      ref={wrapRef}
      onMouseEnter={show}
      onMouseLeave={hide}
      onMouseDown={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {pos && !disabled
        ? createPortal(
            <div className={'hint-bubble ' + side} style={{ left: pos.x, top: pos.y }}>
              {label}
              {keys ? <span className="hint-keys">{keys}</span> : null}
            </div>,
            document.body
          )
        : null}
    </span>
  )
}
