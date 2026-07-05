import { describe, it, expect } from 'vitest'
import { PERMISSION_MODES, isPermissionMode } from './permissionMode'

describe('permissionMode', () => {
  it('lists all five modes in canonical order', () => {
    expect(PERMISSION_MODES).toEqual(['ask', 'accept-edits', 'plan', 'auto', 'bypass'])
  })

  it('accepts every known mode', () => {
    for (const m of ['ask', 'accept-edits', 'plan', 'auto', 'bypass']) {
      expect(isPermissionMode(m)).toBe(true)
    }
  })

  it('rejects unknown or non-string values', () => {
    expect(isPermissionMode('planning')).toBe(false)
    expect(isPermissionMode('')).toBe(false)
    expect(isPermissionMode(null)).toBe(false)
    expect(isPermissionMode(undefined)).toBe(false)
    expect(isPermissionMode(42)).toBe(false)
    expect(isPermissionMode({})).toBe(false)
  })
})
