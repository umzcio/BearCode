import { describe, it, expect } from 'vitest'
import { capMap } from './lruCap'

describe('capMap', () => {
  it('evicts the oldest entries beyond the cap', () => {
    const m = new Map<string, number>()
    for (let i = 0; i < 5; i++) capMap(m, `k${i}`, i, 3)
    expect(m.size).toBe(3)
    expect([...m.keys()]).toEqual(['k2', 'k3', 'k4'])
  })

  it('refreshes recency on re-set (evicts truly-oldest, not the re-set key)', () => {
    const m = new Map<string, number>()
    capMap(m, 'a', 1, 3)
    capMap(m, 'b', 2, 3)
    capMap(m, 'c', 3, 3)
    capMap(m, 'a', 10, 3) // touch 'a' -> now most recent; b is oldest
    capMap(m, 'd', 4, 3) // evicts 'b'
    expect([...m.keys()]).toEqual(['c', 'a', 'd'])
    expect(m.get('a')).toBe(10)
  })
})
