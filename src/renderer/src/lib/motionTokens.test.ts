// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { evaluateCubicBezier, readCssCubicBezier, readCssTimeMs } from './motionTokens'

afterEach(() => {
  document.documentElement.removeAttribute('style')
})

describe('motion token readers', () => {
  it('parses millisecond and second time values', () => {
    document.documentElement.style.setProperty('--test-ms', '180ms')
    document.documentElement.style.setProperty('--test-s', '0.18s')

    expect(readCssTimeMs('--test-ms')).toBe(180)
    expect(readCssTimeMs('--test-s')).toBe(180)
  })

  it('rejects missing, negative, and malformed time values', () => {
    document.documentElement.style.setProperty('--negative', '-1ms')
    document.documentElement.style.setProperty('--unitless', '180')

    expect(readCssTimeMs('--missing')).toBeNull()
    expect(readCssTimeMs('--negative')).toBeNull()
    expect(readCssTimeMs('--unitless')).toBeNull()
  })

  it('parses cubic-bezier values and rejects malformed curves', () => {
    document.documentElement.style.setProperty('--test-curve', 'cubic-bezier(0.23, 1, 0.32, 1)')
    document.documentElement.style.setProperty('--bad-curve', 'ease-out')
    document.documentElement.style.setProperty('--empty-part', 'cubic-bezier(0, , 1, 1)')

    expect(readCssCubicBezier('--test-curve')).toEqual([0.23, 1, 0.32, 1])
    expect(readCssCubicBezier('--bad-curve')).toBeNull()
    expect(readCssCubicBezier('--empty-part')).toBeNull()
    expect(readCssCubicBezier('--missing')).toBeNull()
  })
})

describe('cubic-bezier evaluation', () => {
  it('preserves endpoints and evaluates a linear curve', () => {
    expect(evaluateCubicBezier([0.23, 1, 0.32, 1], 0)).toBe(0)
    expect(evaluateCubicBezier([0.23, 1, 0.32, 1], 1)).toBe(1)
    expect(evaluateCubicBezier([0, 0, 1, 1], 0.5)).toBeCloseTo(0.5, 4)
  })

  it('clamps progress outside zero and one', () => {
    expect(evaluateCubicBezier([0.23, 1, 0.32, 1], -1)).toBe(0)
    expect(evaluateCubicBezier([0.23, 1, 0.32, 1], 2)).toBe(1)
  })
})
