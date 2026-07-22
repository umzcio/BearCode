import { describe, it, expect } from 'vitest'
import { URSA_MODES, isUrsaMode } from './ursaMode'

describe('ursaMode', () => {
  it('accepts review as a mode', () => {
    expect(isUrsaMode('review')).toBe(true)
    expect(URSA_MODES).toContain('review')
  })
})
