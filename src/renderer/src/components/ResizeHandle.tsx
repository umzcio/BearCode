import { useEffect, useRef } from 'react'
import './ResizeHandle.css'

interface ResizeHandleProps {
  onDrag: (dx: number) => void
  onDragEnd?: () => void
}

// A thin draggable divider between two panes. Reports the horizontal drag
// delta since the last move; the parent decides how to apply it (the sidebar
// grows with +dx, the right pane shrinks with +dx). Uses window listeners so
// the drag keeps tracking even when the cursor outruns the 6px hit target.
export function ResizeHandle({ onDrag, onDragEnd }: ResizeHandleProps): React.JSX.Element {
  const lastX = useRef(0)
  const activeCleanup = useRef<(() => void) | null>(null)

  useEffect(
    () => () => {
      activeCleanup.current?.()
    },
    []
  )

  const onMouseDown = (e: React.MouseEvent): void => {
    e.preventDefault()
    lastX.current = e.clientX
    let pendingDx = 0
    let frame: number | null = null

    const flush = (): void => {
      frame = null
      if (pendingDx === 0) return
      const dx = pendingDx
      pendingDx = 0
      onDrag(dx)
    }

    const move = (ev: MouseEvent): void => {
      pendingDx += ev.clientX - lastX.current
      lastX.current = ev.clientX
      if (frame == null) frame = requestAnimationFrame(flush)
    }

    const cleanup = (): void => {
      if (frame != null) {
        cancelAnimationFrame(frame)
        frame = null
      }
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      activeCleanup.current = null
    }

    const up = (): void => {
      if (frame != null) {
        cancelAnimationFrame(frame)
        frame = null
      }
      flush()
      cleanup()
      onDragEnd?.()
    }

    activeCleanup.current = cleanup
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
