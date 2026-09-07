// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { formatPricePer1M } from './formatPrice'

describe('formatPricePer1M', () => {
  it('rounds away binary-float noise', () => {
    expect(formatPricePer1M(3.9600000000000004)).toBe('3.96')
    expect(formatPricePer1M(0.19999999999999998)).toBe('0.2')
  })

  it('keeps meaningful precision and strips trailing zeros', () => {
    expect(formatPricePer1M(0.966)).toBe('0.966')
    expect(formatPricePer1M(0.0375)).toBe('0.0375')
    expect(formatPricePer1M(1.32)).toBe('1.32')
    expect(formatPricePer1M(10)).toBe('10')
    expect(formatPricePer1M(0.3)).toBe('0.3')
  })

  it('never rounds a tiny positive price down to a bare zero', () => {
    expect(formatPricePer1M(0.00004)).toBe('<0.0001')
    expect(formatPricePer1M(0)).toBe('0')
  })
})
