import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../keys', () => ({ getKey: vi.fn() }))
vi.mock('../settings', () => ({ getSettings: vi.fn() }))

import { transcribe, transcribeOpenAI } from './transcribe'
import { getKey } from '../keys'
import { getSettings } from '../settings'

const mockGetKey = vi.mocked(getKey)
const mockGetSettings = vi.mocked(getSettings)

describe('transcribeOpenAI', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockGetKey.mockReset()
    mockGetSettings.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('throws a friendly error before fetch when the key is missing', async () => {
    mockGetKey.mockReturnValue(undefined)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    await expect(transcribeOpenAI(Buffer.from('x'), 'audio/webm')).rejects.toThrow(
      'Add an OpenAI API key in Settings to use voice input.'
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('builds the request with model + auth header and parses { text }', async () => {
    mockGetKey.mockReturnValue('sk-test-123')
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ text: 'hello world' })
    }))
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)

    const result = await transcribeOpenAI(Buffer.from('audio-bytes'), 'audio/webm')
    expect(result).toEqual({ text: 'hello world' })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test-123')
    const body = init.body as FormData
    expect(body).toBeInstanceOf(FormData)
    expect(body.get('model')).toBe('whisper-1')
    expect(body.get('file')).toBeInstanceOf(Blob)
  })

  it('maps a non-OK (401) response to a friendly error including the status', async () => {
    mockGetKey.mockReturnValue('sk-test-123')
    const fetchSpy = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({})
    }))
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)

    await expect(transcribeOpenAI(Buffer.from('x'), 'audio/webm')).rejects.toThrow(
      'OpenAI transcription failed (401)'
    )
  })
})

describe('transcribe dispatch', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockGetKey.mockReset()
    mockGetSettings.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("throws a clear not-available error for the 'local' backend", async () => {
    mockGetSettings.mockReturnValue({ sttBackend: 'local' } as ReturnType<typeof getSettings>)
    await expect(transcribe(Buffer.from('x'), 'audio/webm')).rejects.toThrow(
      "Local transcription isn't available in this build yet"
    )
  })

  it("routes to OpenAI for the 'openai' backend", async () => {
    mockGetSettings.mockReturnValue({ sttBackend: 'openai' } as ReturnType<typeof getSettings>)
    mockGetKey.mockReturnValue('sk-test-123')
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ text: 'routed' })
    }))
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)

    const result = await transcribe(Buffer.from('x'), 'audio/webm')
    expect(result).toEqual({ text: 'routed' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})
