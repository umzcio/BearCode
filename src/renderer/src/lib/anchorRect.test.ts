import { describe, it, expect } from 'vitest'
import { computePopoverPosition } from './usePopoverPosition'
import type { ZoomRect } from './anchorRect'

function rect(top: number, left: number, width: number, height: number): ZoomRect {
  return { top, left, bottom: top + height, right: left + width, width, height }
}

describe('computePopoverPosition', () => {
  it('bottom-start with room below stays bottom-start, origin top left', () => {
    const anchor = rect(100, 20, 100, 20) // bottom = 120
    const pos = computePopoverPosition(anchor, { w: 200, h: 150 }, 'bottom-start', 4, {
      w: 800,
      h: 600
    })
    expect(pos.placement).toBe('bottom-start')
    expect(pos.top).toBe(124)
    expect(pos.left).toBe(20)
    expect(pos.transformOrigin).toBe('top left')
  })

  it('flips to top-start when the anchor is near the viewport bottom with more room above', () => {
    const anchor = rect(550, 20, 100, 30) // bottom = 580
    const pos = computePopoverPosition(anchor, { w: 200, h: 150 }, 'bottom-start', 4, {
      w: 800,
      h: 600
    })
    expect(pos.placement).toBe('top-start')
    expect(pos.top).toBe(396) // 550 - 4 - 150
    expect(pos.left).toBe(20)
    expect(pos.transformOrigin).toBe('bottom left')
  })

  it('shifts a start placement to -end when it overflows the right edge', () => {
    const anchor = rect(100, 700, 50, 20) // right = 750
    const pos = computePopoverPosition(anchor, { w: 300, h: 150 }, 'bottom-start', 4, {
      w: 800,
      h: 600
    })
    expect(pos.placement).toBe('bottom-end')
    expect(pos.left).toBe(450) // 750 - 300
    expect(pos.transformOrigin).toBe('top right')
  })
})
