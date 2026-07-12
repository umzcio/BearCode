import type { ZoomRect } from './anchorRect'
import { viewportSize } from './anchorRect'

export type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'

export interface PopoverPos {
  top: number
  left: number
  placement: Placement
  transformOrigin: string
}

const ORIGIN: Record<Placement, string> = {
  'bottom-start': 'top left',
  'bottom-end': 'top right',
  'top-start': 'bottom left',
  'top-end': 'bottom right'
}

// Given the anchor rect + measured content size + preferred placement,
// returns a viewport-flipped position: fixed-position popovers should never
// render off-screen, so flip vertically when there's not enough room in the
// preferred direction (and more room the other way), and shift horizontally
// from `-start` to `-end` when a left-aligned menu would overflow the right
// edge.
//
// `viewport` defaults to the real `viewportSize()` but is injectable so this
// stays a pure, easily-tested function.
export function computePopoverPosition(
  anchor: ZoomRect,
  content: { w: number; h: number },
  prefer: Placement,
  gap = 4,
  viewport: { w: number; h: number } = viewportSize()
): PopoverPos {
  const [preferVertical, preferHorizontal] = prefer.split('-') as [
    'bottom' | 'top',
    'start' | 'end'
  ]

  const spaceBelow = viewport.h - anchor.bottom - gap
  const spaceAbove = anchor.top - gap

  let vertical = preferVertical
  if (preferVertical === 'bottom' && spaceBelow < content.h && spaceAbove > spaceBelow) {
    vertical = 'top'
  } else if (preferVertical === 'top' && spaceAbove < content.h && spaceBelow > spaceAbove) {
    vertical = 'bottom'
  }

  let horizontal = preferHorizontal
  if (horizontal === 'start' && anchor.left + content.w > viewport.w) {
    horizontal = 'end'
  } else if (horizontal === 'end' && anchor.right - content.w < 0) {
    horizontal = 'start'
  }

  const placement = `${vertical}-${horizontal}` as Placement

  const top = vertical === 'bottom' ? anchor.bottom + gap : anchor.top - gap - content.h
  const left = horizontal === 'start' ? anchor.left : anchor.right - content.w

  return { top, left, placement, transformOrigin: ORIGIN[placement] }
}
