import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./store', () => ({
  loadIntegrationToken: vi.fn()
}))

import { loadIntegrationToken } from './store'
import {
  githubDeviceStart,
  githubDevicePoll,
  githubConnectPat,
  githubApi,
  GITHUB_CLIENT_ID
} from './github'

const mockedLoadToken = vi.mocked(loadIntegrationToken)

function jsonResponse(
  body: unknown,
  init: { ok?: boolean; status?: number; headers?: Record<string, string> } = {}
): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: new Headers(init.headers ?? {}),
    json: async () => body
  } as unknown as Response
}

describe('integrations/github', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    global.fetch = vi.fn()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('githubDeviceStart', () => {
    it('parses the device code response', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          device_code: 'dev-123',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5
        })
      ) as unknown as typeof fetch

      const result = await githubDeviceStart()

      expect(result).toEqual({
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
        deviceCode: 'dev-123',
        interval: 5
      })
      expect(global.fetch).toHaveBeenCalledWith(
        'https://github.com/login/device/code',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining(GITHUB_CLIENT_ID)
        })
      )
    })

    it('throws when the request fails', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({}, { ok: false, status: 500 })) as unknown as typeof fetch
      await expect(githubDeviceStart()).rejects.toThrow('GitHub device code request failed (500)')
    })
  })

  describe('githubDevicePoll', () => {
    it('resolves after pending -> slow_down -> success', async () => {
      vi.useFakeTimers()
      const fetchMock = vi
        .fn()
        // 1st poll: still pending
        .mockResolvedValueOnce(jsonResponse({ error: 'authorization_pending' }))
        // 2nd poll: slow down, widen interval
        .mockResolvedValueOnce(jsonResponse({ error: 'slow_down', interval: 10 }))
        // 3rd poll: success
        .mockResolvedValueOnce(jsonResponse({ access_token: 'gho_abc', scope: 'repo,read:user' }))
        // /user validation call
        .mockResolvedValueOnce(
          jsonResponse({ login: 'zach' }, { headers: { 'x-oauth-scopes': 'repo, read:user' } })
        )
      global.fetch = fetchMock as unknown as typeof fetch

      const promise = githubDevicePoll('dev-123', 1)

      // Drain the sleep()->fetch chain: run all pending timers/microtasks
      // repeatedly until the poll resolves.
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(20000)
      }

      const result = await promise
      expect(result).toEqual({ token: 'gho_abc', login: 'zach', scopes: ['repo', 'read:user'] })
      expect(fetchMock).toHaveBeenCalledTimes(4)
    })

    it('throws on expired_token', async () => {
      vi.useFakeTimers()
      global.fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({ error: 'expired_token' })) as unknown as typeof fetch

      const promise = githubDevicePoll('dev-123', 1)
      const assertion = expect(promise).rejects.toThrow(
        'GitHub device code expired -- start sign-in again.'
      )
      await vi.advanceTimersByTimeAsync(2000)
      await assertion
    })

    it('throws on access_denied', async () => {
      vi.useFakeTimers()
      global.fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({ error: 'access_denied' })) as unknown as typeof fetch

      const promise = githubDevicePoll('dev-123', 1)
      const assertion = expect(promise).rejects.toThrow('GitHub sign-in was denied.')
      await vi.advanceTimersByTimeAsync(2000)
      await assertion
    })
  })

  describe('githubConnectPat', () => {
    it('validates the token via GET /user', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ login: 'zach' }, { headers: { 'x-oauth-scopes': 'repo, gist' } })
        ) as unknown as typeof fetch

      const result = await githubConnectPat('pat-token')

      expect(result).toEqual({ login: 'zach', scopes: ['repo', 'gist'] })
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.github.com/user',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer pat-token' })
        })
      )
    })

    it('throws on an invalid token', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({}, { ok: false, status: 401 })) as unknown as typeof fetch
      await expect(githubConnectPat('bad-token')).rejects.toThrow(
        'GitHub token validation failed (401)'
      )
    })
  })

  describe('githubApi', () => {
    it('throws an actionable error when GitHub is not connected', async () => {
      mockedLoadToken.mockReturnValue(undefined)
      await expect(githubApi('/repos/foo/bar')).rejects.toThrow(
        'GitHub is not connected. Connect it in Settings -> Integrations.'
      )
      expect(global.fetch).not.toHaveBeenCalled()
    })

    it('injects the stored token as a bearer header', async () => {
      mockedLoadToken.mockReturnValue({ token: 'gho_stored' })
      global.fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({ ok: true })) as unknown as typeof fetch

      await githubApi('/repos/foo/bar')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/foo/bar',
        expect.objectContaining({
          headers: expect.any(Headers)
        })
      )
      const call = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
      const headers = call[1].headers as Headers
      expect(headers.get('Authorization')).toBe('Bearer gho_stored')
    })
  })
})
