import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../keys', () => ({ getKey: vi.fn() }))

// The local backend loads a ~150 MB model at runtime — NEVER in a test. Mock
// the transformers pipeline (and electron's userData path it caches under) so
// transcribeLocal resolves synchronously to a canned transcript. vi.hoisted so
// the mocks exist when the hoisted vi.mock factory runs.
const { mockTranscriber, mockPipeline } = vi.hoisted(() => {
  const transcriber = vi.fn(async () => ({ text: '  local transcript  ' }))
  return { mockTranscriber: transcriber, mockPipeline: vi.fn(async () => transcriber) }
})
vi.mock('@xenova/transformers', () => ({
  pipeline: mockPipeline,
  env: {}
}))
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/whisper-test' } }))

import { transcribe, transcribeOpenAI } from './transcribe'
import { getKey } from '../keys'

const mockGetKey = vi.mocked(getKey)

// A tiny PCM ArrayBuffer standing in for renderer-decoded 16 kHz mono audio.
const pcmBuffer = (): ArrayBuffer => new Float32Array([0, 0.1, -0.1]).buffer

describe('transcribeOpenAI', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockGetKey.mockReset()
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

describe('transcribe dispatch (routes on meta.kind)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockGetKey.mockReset()
    mockPipeline.mockClear()
    mockTranscriber.mockClear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("routes a 'pcm' payload to the local (mocked) Whisper pipeline, not fetch", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await transcribe(pcmBuffer(), { kind: 'pcm', sampleRate: 16000 })

    expect(result).toEqual({ text: 'local transcript' }) // trimmed
    expect(mockPipeline).toHaveBeenCalledWith('automatic-speech-recognition', 'Xenova/whisper-base')
    expect(mockTranscriber).toHaveBeenCalledTimes(1)
    expect(mockTranscriber.mock.calls[0][0]).toBeInstanceOf(Float32Array)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("routes a 'webm' payload to OpenAI (mocked fetch), not the local pipeline", async () => {
    mockGetKey.mockReturnValue('sk-test-123')
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ text: 'routed' })
    }))
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)

    const result = await transcribe(new ArrayBuffer(4), { kind: 'webm', mimeType: 'audio/webm' })

    expect(result).toEqual({ text: 'routed' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(mockTranscriber).not.toHaveBeenCalled()
  })
})
