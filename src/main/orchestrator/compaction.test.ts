import { describe, it, expect } from 'vitest'
import { compactionAdvanced } from './compaction'

describe('compactionAdvanced', () => {
  it('reports no advance when there is no summarization event', () => {
    expect(compactionAdvanced(null, undefined)).toEqual({
      advanced: false,
      summarizedCount: 0
    })
    expect(compactionAdvanced(10, undefined)).toEqual({
      advanced: false,
      summarizedCount: 0
    })
  })

  it('advances on the first summarization from a null baseline', () => {
    expect(compactionAdvanced(null, { cutoffIndex: 12 })).toEqual({
      advanced: true,
      summarizedCount: 12
    })
  })

  it('advances when the cutoff grows past the previous marker', () => {
    expect(compactionAdvanced(12, { cutoffIndex: 24 })).toEqual({
      advanced: true,
      summarizedCount: 24
    })
  })

  it('does not advance when the cutoff is unchanged', () => {
    expect(compactionAdvanced(24, { cutoffIndex: 24 })).toEqual({
      advanced: false,
      summarizedCount: 0
    })
  })

  it('does not advance when the cutoff is lower than the previous marker', () => {
    expect(compactionAdvanced(24, { cutoffIndex: 10 })).toEqual({
      advanced: false,
      summarizedCount: 0
    })
  })

  it('treats a zero baseline like null (a positive cutoff advances)', () => {
    expect(compactionAdvanced(0, { cutoffIndex: 5 })).toEqual({
      advanced: true,
      summarizedCount: 5
    })
  })

  it('ignores a non-finite / non-number cutoff', () => {
    expect(compactionAdvanced(0, { cutoffIndex: NaN })).toEqual({
      advanced: false,
      summarizedCount: 0
    })
    // guards against the middleware shape drifting to a non-number
    expect(compactionAdvanced(0, { cutoffIndex: undefined as unknown as number })).toEqual({
      advanced: false,
      summarizedCount: 0
    })
  })
})
