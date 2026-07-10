import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./store', () => ({
  getIntegration: vi.fn(),
  loadIntegrationToken: vi.fn()
}))

import { getIntegration, loadIntegrationToken } from './store'
import { bitbucketConnect, bitbucketApi } from './bitbucket'

const mockedGetIntegration = vi.mocked(getIntegration)
const mockedLoadToken = vi.mocked(loadIntegrationToken)

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body
  } as unknown as Response
}

describe('integrations/bitbucket', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    global.fetch = vi.fn()
  })

  describe('bitbucketConnect', () => {
    it('validates the app password via GET /2.0/user (Basic auth)', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({ username: 'bbuser' })) as unknown as typeof fetch

      const result = await bitbucketConnect('bbuser', 'app-pass-xyz')

      expect(result).toEqual({ username: 'bbuser' })
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.bitbucket.org/2.0/user',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Basic ${Buffer.from('bbuser:app-pass-xyz').toString('base64')}`
          })
        })
      )
    })

    it('falls back to the entered username if the response omits it', async () => {
      global.fetch = vi.fn().mockResolvedValue(jsonResponse({})) as unknown as typeof fetch
      const result = await bitbucketConnect('bbuser', 'app-pass-xyz')
      expect(result).toEqual({ username: 'bbuser' })
    })

    it('throws on an invalid app password', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({}, { ok: false, status: 401 })) as unknown as typeof fetch
      await expect(bitbucketConnect('bbuser', 'bad-pass')).rejects.toThrow(
        'Bitbucket app password validation failed (401)'
      )
    })
  })

  describe('bitbucketApi', () => {
    it('throws an actionable error when Bitbucket is not connected', async () => {
      mockedGetIntegration.mockReturnValue({ provider: 'bitbucket', connected: false })
      mockedLoadToken.mockReturnValue(undefined)
      await expect(bitbucketApi('/repositories/team')).rejects.toThrow(
        'Bitbucket is not connected. Connect it in Settings -> Integrations.'
      )
      expect(global.fetch).not.toHaveBeenCalled()
    })

    it('throws when connected but the token is missing (inconsistent state)', async () => {
      mockedGetIntegration.mockReturnValue({
        provider: 'bitbucket',
        connected: true,
        login: 'bbuser'
      })
      mockedLoadToken.mockReturnValue(undefined)
      await expect(bitbucketApi('/repositories/team')).rejects.toThrow(
        'Bitbucket is not connected. Connect it in Settings -> Integrations.'
      )
    })

    it('injects a Basic auth header built from state.login + the stored token', async () => {
      mockedGetIntegration.mockReturnValue({
        provider: 'bitbucket',
        connected: true,
        login: 'bbuser'
      })
      mockedLoadToken.mockReturnValue({ token: 'app-pass-xyz' })
      global.fetch = vi.fn().mockResolvedValue(jsonResponse({})) as unknown as typeof fetch

      await bitbucketApi('/repositories/team')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.bitbucket.org/2.0/repositories/team',
        expect.objectContaining({ headers: expect.any(Headers) })
      )
      const call = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
      const headers = call[1].headers as Headers
      expect(headers.get('Authorization')).toBe(
        `Basic ${Buffer.from('bbuser:app-pass-xyz').toString('base64')}`
      )
    })
  })
})
