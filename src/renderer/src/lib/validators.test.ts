import { describe, it, expect } from 'vitest'
import { isKebabName, KEBAB_PATTERN, KEBAB_HINT } from './validators'

describe('isKebabName', () => {
  it('accepts a simple kebab-case name', () => {
    expect(isKebabName('my-name')).toBe(true)
  })

  it('accepts a single lowercase letter', () => {
    expect(isKebabName('a')).toBe(true)
  })

  it('accepts digits', () => {
    expect(isKebabName('my-name-2')).toBe(true)
  })

  it('rejects uppercase / underscores', () => {
    expect(isKebabName('My_Name')).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(isKebabName('')).toBe(false)
  })

  it('rejects a name starting with a dash', () => {
    expect(isKebabName('-name')).toBe(false)
  })

  it('matches the exported pattern directly', () => {
    expect(KEBAB_PATTERN.test('another-valid-name')).toBe(true)
    expect(KEBAB_PATTERN.test('Not Valid')).toBe(false)
  })

  it('exposes a human-readable hint', () => {
    expect(KEBAB_HINT.length).toBeGreaterThan(0)
  })
})
