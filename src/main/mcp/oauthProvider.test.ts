import { describe, it, expect, vi, beforeEach } from 'vitest'

// In-memory vault (keys.ts) so no real safeStorage/fs I/O happens; this also
// lets us assert the exact namespaced keys the provider reads/writes.
const fakeVault = new Map<string, string>()
vi.mock('../keys', () => ({
  setVaultSecret: vi.fn((key: string, value: string) => {
    if (!value) fakeVault.delete(key)
    else fakeVault.set(key, value)
  }),
  getVaultSecret: vi.fn((key: string) => fakeVault.get(key))
}))

// Mocked system browser — never actually shells out.
const openSignIn = vi.fn(async (_url: string) => {})
vi.mock('../oauth/browser', () => ({ openSignIn: (url: string) => openSignIn(url) }))

// Mocked loopback capture — no real http.Server. `wait()` resolves only when
// the test hands us a redirect, mirroring a user completing sign-in.
let waitResolve: ((p: URLSearchParams) => void) | undefined
const fakeClose = vi.fn()
const fakeWait = vi.fn(
  () =>
    new Promise<URLSearchParams>((res) => {
      waitResolve = res
    })
)
const startLoopbackCapture = vi.fn(async () => ({
  redirectUri: 'http://127.0.0.1:54321/callback',
  wait: fakeWait,
  close: fakeClose
}))
vi.mock('../oauth/loopback', () => ({
  startLoopbackCapture: () => startLoopbackCapture()
}))

import { makeMcpOAuthProvider } from './oauthProvider'

// Flush the microtask/timer queue so awaited internal steps (loopback prepare,
// browser open) have run before we assert on them.
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('mcp/oauthProvider', () => {
  beforeEach(() => {
    fakeVault.clear()
    openSignIn.mockClear()
    startLoopbackCapture.mockClear()
    fakeWait.mockClear()
    fakeClose.mockClear()
    waitResolve = undefined
  })

  it('round-trips client information through the oauth:mcp:<server>:client vault key', async () => {
    const p = makeMcpOAuthProvider('gmail')
    expect(await p.clientInformation()).toBeUndefined()
    await p.saveClientInformation?.({ client_id: 'cid-1', client_secret: 'sec-1' })
    expect(fakeVault.has('oauth:mcp:gmail:client')).toBe(true)
    expect(fakeVault.has('oauth:mcp:gmail:tokens')).toBe(false)
    expect(await p.clientInformation()).toEqual({ client_id: 'cid-1', client_secret: 'sec-1' })
  })

  it('round-trips tokens through the oauth:mcp:<server>:tokens vault key', async () => {
    const p = makeMcpOAuthProvider('notion')
    expect(await p.tokens()).toBeUndefined()
    await p.saveTokens({ access_token: 'at-1', token_type: 'Bearer', refresh_token: 'rt-1' })
    expect(fakeVault.has('oauth:mcp:notion:tokens')).toBe(true)
    expect(await p.tokens()).toEqual({
      access_token: 'at-1',
      token_type: 'Bearer',
      refresh_token: 'rt-1'
    })
  })

  it('keeps the PKCE code verifier in memory, never in the vault', async () => {
    const p = makeMcpOAuthProvider('linear')
    await p.saveCodeVerifier('verifier-xyz')
    expect(await p.codeVerifier()).toBe('verifier-xyz')
    // No vault key was written for the verifier.
    expect([...fakeVault.keys()].some((k) => k.includes('linear'))).toBe(false)
  })

  it('codeVerifier() throws when none was saved for the session', () => {
    const p = makeMcpOAuthProvider('linear')
    expect(() => p.codeVerifier()).toThrow()
  })

  it('exposes a public-client metadata document with the loopback redirect after prepare()', async () => {
    const p = makeMcpOAuthProvider('gmail')
    expect(p.redirectUrl).toBeUndefined()
    await p.prepare()
    expect(p.redirectUrl).toBe('http://127.0.0.1:54321/callback')
    const md = p.clientMetadata
    expect(md.client_name).toBe('BearCode')
    expect(md.token_endpoint_auth_method).toBe('none')
    expect(md.grant_types).toEqual(['authorization_code', 'refresh_token'])
    expect(md.response_types).toEqual(['code'])
    expect(md.redirect_uris).toEqual(['http://127.0.0.1:54321/callback'])
  })

  it('prepare() is idempotent — one loopback server per provider', async () => {
    const p = makeMcpOAuthProvider('gmail')
    await p.prepare()
    await p.prepare()
    expect(startLoopbackCapture).toHaveBeenCalledTimes(1)
  })

  it('redirectToAuthorization opens the system browser and awaits the captured code', async () => {
    const p = makeMcpOAuthProvider('gmail')
    const authUrl = new URL('https://auth.example.com/authorize?client_id=cid')
    const pending = p.redirectToAuthorization(authUrl)
    // Browser opened with the authorization URL.
    await flush()
    expect(openSignIn).toHaveBeenCalledWith(authUrl.toString())
    // Simulate the user completing sign-in on the loopback callback.
    expect(waitResolve).toBeDefined()
    waitResolve!(new URLSearchParams('code=auth-code-123&state=st'))
    await pending
    // The code is available exactly once for the SDK continuation.
    expect(p.takeAuthorizationCode()).toBe('auth-code-123')
    expect(p.takeAuthorizationCode()).toBeUndefined()
  })

  it('redirectToAuthorization rejects when the IdP returns an error in the callback', async () => {
    const p = makeMcpOAuthProvider('gmail')
    const pending = p.redirectToAuthorization(new URL('https://auth.example.com/authorize'))
    await flush()
    expect(waitResolve).toBeDefined()
    waitResolve!(new URLSearchParams('error=access_denied&error_description=nope'))
    await expect(pending).rejects.toThrow(/access_denied/)
    expect(p.takeAuthorizationCode()).toBeUndefined()
  })

  it('invalidateCredentials clears the right vault keys per scope', async () => {
    const p = makeMcpOAuthProvider('gmail')
    await p.saveClientInformation?.({ client_id: 'cid' })
    await p.saveTokens({ access_token: 'at', token_type: 'Bearer' })
    await p.saveCodeVerifier('v')

    await p.invalidateCredentials?.('tokens')
    expect(fakeVault.has('oauth:mcp:gmail:tokens')).toBe(false)
    expect(fakeVault.has('oauth:mcp:gmail:client')).toBe(true)

    await p.invalidateCredentials?.('all')
    expect(fakeVault.has('oauth:mcp:gmail:client')).toBe(false)
    expect(() => p.codeVerifier()).toThrow()
  })

  it('dispose() closes an in-flight loopback capture', async () => {
    const p = makeMcpOAuthProvider('gmail')
    await p.prepare()
    p.dispose()
    expect(fakeClose).toHaveBeenCalled()
  })
})
