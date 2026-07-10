import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the underlying vault (keys.ts) in-memory so no real fs/safeStorage
// I/O touches disk during the test run, mirroring keys.mcp.test.ts.
const fakeVault = new Map<string, string>()

vi.mock('../keys', () => ({
  setVaultSecret: vi.fn((key: string, value: string) => {
    if (!value) {
      fakeVault.delete(key)
    } else {
      fakeVault.set(key, value)
    }
  }),
  getVaultSecret: vi.fn((key: string) => fakeVault.get(key))
}))

import { saveOAuth, loadOAuth, clearOAuth } from './credentials'

describe('oauth/credentials', () => {
  beforeEach(() => {
    fakeVault.clear()
  })

  it('round-trips an object through the vault, JSON-encoded', () => {
    saveOAuth('oauth:github', { token: 'tok-123', login: 'zach' })
    expect(fakeVault.get('oauth:github')).toBe(JSON.stringify({ token: 'tok-123', login: 'zach' }))
    expect(loadOAuth<{ token: string; login: string }>('oauth:github')).toEqual({
      token: 'tok-123',
      login: 'zach'
    })
  })

  it('returns undefined when nothing is stored', () => {
    expect(loadOAuth('oauth:missing')).toBeUndefined()
  })

  it('returns undefined and does not throw on malformed JSON', () => {
    fakeVault.set('oauth:corrupt', 'not-json{')
    expect(loadOAuth('oauth:corrupt')).toBeUndefined()
  })

  it('clears a stored credential', () => {
    saveOAuth('oauth:mcp:gmail:tokens', { accessToken: 'a' })
    expect(loadOAuth('oauth:mcp:gmail:tokens')).toBeDefined()
    clearOAuth('oauth:mcp:gmail:tokens')
    expect(loadOAuth('oauth:mcp:gmail:tokens')).toBeUndefined()
    expect(fakeVault.has('oauth:mcp:gmail:tokens')).toBe(false)
  })
})
