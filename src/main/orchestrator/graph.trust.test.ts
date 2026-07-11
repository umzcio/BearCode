import { describe, it, expect, vi } from 'vitest'

vi.mock('../db', () => ({
  isProjectTrusted: vi.fn(() => true),
  getOutsidePolicy: vi.fn(() => ({ policy: 'ask', allowed: [], denied: [] })),
  recordPendingOutsidePath: vi.fn()
}))

import { isProjectTrusted, getOutsidePolicy } from '../db'
import { resolveTrustForTurn } from './graph'

describe('resolveTrustForTurn', () => {
  it('returns trusted flag + outside policy for an open project', () => {
    const r = resolveTrustForTurn('/proj')
    expect(r.trusted).toBe(true)
    expect(r.outside).toEqual({ policy: 'ask', allowed: [], denied: [] })
    expect(isProjectTrusted).toHaveBeenCalledWith('/proj')
    expect(getOutsidePolicy).toHaveBeenCalledWith('/proj')
  })

  it('no project open ⇒ untrusted, no policy', () => {
    const r = resolveTrustForTurn(null)
    expect(r.trusted).toBe(false)
    expect(r.outside).toBeUndefined()
  })
})
