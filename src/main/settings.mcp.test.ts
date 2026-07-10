import { describe, it, expect } from 'vitest'
import { coerceStringArrayMap } from './settings'

describe('coerceStringArrayMap', () => {
  it('keeps string arrays per key and drops non-strings', () => {
    expect(coerceStringArrayMap({ '/p': ['a', 1, 'b'], '/q': 'x' })).toEqual({ '/p': ['a', 'b'], '/q': [] })
  })
  it('returns {} for non-objects', () => {
    expect(coerceStringArrayMap(null)).toEqual({})
    expect(coerceStringArrayMap(42)).toEqual({})
  })
})
