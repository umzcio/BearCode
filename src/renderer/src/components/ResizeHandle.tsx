import { useRef } from 'react'
import './ResizeHandle.css'

// A thin draggable divider between two panes. Reports the horizontal drag
// delta since the last move; the parent decides how to apply it (the sidebar
// grows with +dx, the right pane shrinks with +dx). Uses window listeners so
// the drag keeps tracking even when the cursor outruns the 6px hit target.
export function ResizeHandle({ onDrag }: { onDrag: (dx: number) => void }): React.JSX.Element {
  const lastX = useRef(0)

  const onMouseDown = (e: React.MouseEvent): void => {
    e.preventDefault()
    lastX.current = e.clientX
    const move = (ev: MouseEvent): void => {
      onDrag(ev.clientX - lastX.current)
      lastX.current = ev.clientX
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  return (
    <div
      className="resize-handle"
      role="separator"
      aria-orientation="vertical"
      onMouseDown={onMouseDown}
    />
  )
}
