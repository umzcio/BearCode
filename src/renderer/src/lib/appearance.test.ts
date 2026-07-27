// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type { FontSize } from '@shared/appearance'
import { applyAppearance, type Appearance } from './appearance'

const BASE_APPEARANCE: Appearance = {
  theme: 'dark',
  customColors: {
    bg: '#1b1b1b',
    fg: '#e7e7e7',
    accent: '#4c8dff'
  },
  fontSize: 'medium',
  conversationWidth: 'default',
  reduceMotion: false,
  chatFont: 'sans'
}

const CASES: { fontSize: FontSize; zoom: number }[] = [
  { fontSize: 'small', zoom: 0.9 },
  { fontSize: 'medium', zoom: 1 },
  { fontSize: 'large', zoom: 1.1 }
]

afterEach(() => {
  const root = document.documentElement
  root.style.removeProperty('zoom')
  root.style.removeProperty('--window-controls-left')
  root.style.removeProperty('--window-controls-top')
  root.style.removeProperty('--window-controls-scale')
  root.style.removeProperty('--window-controls-hit-width')
  root.style.removeProperty('--collapsed-topbar-content-left')
})

describe('applyAppearance window chrome geometry', () => {
  it.each(CASES)(
    'keeps the controls physically anchored at $fontSize zoom',
    ({ fontSize, zoom }) => {
      applyAppearance({ ...BASE_APPEARANCE, fontSize })

      const style = document.documentElement.style
      expect(style.zoom).toBe(String(zoom))
      expect(parseFloat(style.getPropertyValue('--window-controls-left')) * zoom).toBeCloseTo(87)
      expect(parseFloat(style.getPropertyValue('--window-controls-top')) * zoom).toBeCloseTo(16)
      expect(parseFloat(style.getPropertyValue('--window-controls-scale')) * zoom).toBeCloseTo(1)
      expect(
        parseFloat(style.getPropertyValue('--window-controls-hit-width')) * zoom
      ).toBeCloseTo(164)
      expect(
        parseFloat(style.getPropertyValue('--collapsed-topbar-content-left')) * zoom
      ).toBeCloseTo(134)
    }
  )
})
