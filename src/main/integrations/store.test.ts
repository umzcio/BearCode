import { describe, it, expect, vi, beforeEach } from 'vitest'

const fakeVault = new Map<string, unknown>()

vi.mock('../oauth/credentials', () => ({
  saveOAuth: vi.fn((ns: string, data: unknown) => fakeVault.set(ns, data)),
  loadOAuth: vi.fn((ns: string) => fakeVault.get(ns)),
  clearOAuth: vi.fn((ns: string) => fakeVault.delete(ns))
}))

import {
  getIntegration,
  setIntegration,
  disconnect,
  saveIntegrationToken,
  loadIntegrationToken
} from './store'

describe('integrations/store', () => {
  beforeEach(() => {
    fakeVault.clear()
  })

  it('returns a disconnected default state when nothing is stored', () => {
    expect(getIntegration('github')).toEqual({ provider: 'github', connected: false })
  })

  it('round-trips connection state', () => {
    setIntegration('github', {
      provider: 'github',
      connected: true,
      method: 'pat',
      login: 'zach',
      scopes: ['repo'],
      connectedAt: 123
    })
    expect(getIntegration('github')).toEqual({
      provider: 'github',
      connected: true,
      method: 'pat',
      login: 'zach',
      scopes: ['repo'],
      connectedAt: 123
    })
  })

  it('round-trips the token separately from state', () => {
    saveIntegrationToken('github', { token: 'tok-abc' })
    expect(loadIntegrationToken<{ token: string }>('github')).toEqual({ token: 'tok-abc' })
    // state namespace is untouched by the token write
    expect(getIntegration('github')).toEqual({ provider: 'github', connected: false })
  })

  it('disconnect clears both state and token', () => {
    setIntegration('bitbucket', { provider: 'bitbucket', connected: true, method: 'app-password' })
    saveIntegrationToken('bitbucket', { username: 'z', appPassword: 'p' })

    disconnect('bitbucket')

    expect(getIntegration('bitbucket')).toEqual({ provider: 'bitbucket', connected: false })
    expect(loadIntegrationToken('bitbucket')).toBeUndefined()
  })

  it('keeps github and bitbucket state independent', () => {
    setIntegration('github', { provider: 'github', connected: true })
    setIntegration('bitbucket', { provider: 'bitbucket', connected: false })
    expect(getIntegration('github').connected).toBe(true)
    expect(getIntegration('bitbucket').connected).toBe(false)
  })
})
