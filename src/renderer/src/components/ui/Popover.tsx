import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { zoomedRect } from '../../lib/anchorRect'
import {
  computePopoverPosition,
  type Placement,
  type PopoverPos
} from '../../lib/usePopoverPosition'
import './Popover.css'

export interface PopoverProps {
  // `| null` because `useRef<HTMLElement>(null)` types as
  // RefObject<HTMLElement | null> in React 19 -- accept whatever a caller's
  // element ref naturally is instead of forcing an `as` cast at call sites.
  anchorRef: React.RefObject<HTMLElement | null>
  open: boolean
  onClose: () => void
  placement?: Placement
  // min-width = anchor width, e.g. Select's dropdown matching the trigger.
  matchAnchorWidth?: boolean
  className?: string
  children: React.ReactNode
}

// Shared floating-surface primitive: portals to <body>, measures the anchor
// + its own content, and positions itself `fixed` via computePopoverPosition
// (viewport-flipped). Every popover/menu in the app (Select, ConvoRowMenu,
// FieldHint, ...) should build on this rather than re-deriving the zoom +
// positioning math per-component.
export function Popover({
  anchorRef,
  open,
  onClose,
  placement = 'bottom-start',
  matchAnchorWidth = false,
  className,
  children
}: PopoverProps): React.JSX.Element | null {
  const popRef = useRef<HTMLDivElement>(null)
  // `pos` doubles as the "have we measured yet" flag: null keeps the popover
  // hidden (but still mounted so it can be measured) to avoid a flash at the
  // wrong spot before the first layout pass lands.
  const [pos, setPos] = useState<(PopoverPos & { minWidth?: number }) | null>(null)

  useLayoutEffect(() => {
    // No reset-to-null on close: the component already renders nothing
    // while `!open` (see below), so there's nothing to visually reset --
    // and leaving the last-known `pos` around means a quick reopen has a
    // reasonable position to paint even before this effect recomputes it.
    if (!open) return undefined
    const anchorEl = anchorRef.current
    const popEl = popRef.current
    if (!anchorEl || !popEl) return undefined
    const anchor = zoomedRect(anchorEl)
    const content = { w: popEl.offsetWidth, h: popEl.offsetHeight }
    const next = computePopoverPosition(anchor, content, placement)
    setPos({ ...next, minWidth: matchAnchorWidth ? anchor.width : undefined })
    return undefined
  }, [open, placement, matchAnchorWidth, anchorRef])

  useLayoutEffect(() => {
    if (!open) return undefined

    // Esc dismisses -- capture-phase + stopPropagation so it doesn't bubble
    // to ancestor handlers (e.g. Settings' own Esc-to-close).
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    // Click-outside: pointerdown outside both the anchor and the popover.
    const onPointerDown = (e: PointerEvent): void => {
      const t = e.target as Node
      if (anchorRef.current?.contains(t)) return
      if (popRef.current?.contains(t)) return
      onClose()
    }
    // A fixed-positioned popover detaches from its anchor on scroll/resize
    // (e.g. a scrollable settings card scrolling underneath it), so close it
    // rather than let it float in the wrong place -- matching Select /
    // ConvoRowMenu. Ignore scrolls that originate from within the popover
    // itself (a long option list scrolling shouldn't close it).
    const onResize = (): void => onClose()
    const onScroll = (e: Event): void => {
      const t = e.target as Node
      if (popRef.current?.contains(t)) return
      onClose()
    }

    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, onClose, anchorRef])

  if (!open) return null

  return createPortal(
    <div
      ref={popRef}
      className={'popover' + (className ? ` ${className}` : '')}
      style={{
        position: 'fixed',
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        minWidth: pos?.minWidth,
        // Hidden (but mounted + measurable) until the first layout pass has
        // computed a real position, so it never flashes at (0, 0).
        visibility: pos ? 'visible' : 'hidden',
        transformOrigin: pos?.transformOrigin ?? 'top left'
      }}
    >
      {children}
    </div>,
    document.body
  )
}
