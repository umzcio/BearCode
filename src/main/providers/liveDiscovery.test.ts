import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchAnthropicModels, fetchGoogleModels, fetchOpenAIModels } from './liveDiscovery'

const originalFetch = global.fetch

afterEach(() => {
  global.fetch = originalFetch
  vi.restoreAllMocks()
})

function mockFetchOnce(body: unknown, ok = true): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    json: () => Promise.resolve(body)
  }) as unknown as typeof fetch
}

describe('fetchAnthropicModels', () => {
  it('maps id/display_name/max_input_tokens and the covered capability flags', async () => {
    mockFetchOnce({
      data: [
        {
          id: 'claude-opus-4-8',
          display_name: 'Claude Opus 4.8',
          max_input_tokens: 1_000_000,
          capabilities: {
            image_input: { supported: true },
            structured_outputs: { supported: true },
            thinking: { supported: false },
            code_execution: { supported: true },
            pdf_input: { supported: true }
          }
        }
      ],
      has_more: false,
      last_id: 'claude-opus-4-8'
    })
    const result = await fetchAnthropicModels('sk-test')
    expect(result?.models).toEqual([
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', contextWindow: 1_000_000 }
    ])
    expect(result?.capabilities['claude-opus-4-8']).toEqual({
      vision: true,
      responseSchema: true,
      reasoning: false,
      codeExecution: true,
      pdfInput: true
    })
  })

  it('omits capability fields the response is silent on, rather than defaulting them to false', async () => {
    mockFetchOnce({
      data: [
        {
          id: 'claude-haiku-4-5',
          display_name: 'Claude Haiku 4.5',
          capabilities: { image_input: { supported: true } }
        }
      ],
      has_more: false,
      last_id: 'claude-haiku-4-5'
    })
    const result = await fetchAnthropicModels('sk-test')
    expect(result?.capabilities['claude-haiku-4-5']).toEqual({ vision: true })
  })

  it('treats a 0 max_input_tokens as unknown, not a real context window', async () => {
    mockFetchOnce({
      data: [{ id: 'x', display_name: 'X', max_input_tokens: 0 }],
      has_more: false,
      last_id: 'x'
    })
    const result = await fetchAnthropicModels('sk-test')
    expect(result?.models[0].contextWindow).toBeUndefined()
  })

  it('follows has_more/last_id pagination across multiple pages', async () => {
    let call = 0
    global.fetch = vi.fn().mockImplementation(() => {
      call++
      if (call === 1) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [{ id: 'a', display_name: 'A' }],
              has_more: true,
              last_id: 'a'
            })
        })
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ data: [{ id: 'b', display_name: 'B' }], has_more: false, last_id: 'b' })
      })
    }) as unknown as typeof fetch
    const result = await fetchAnthropicModels('sk-test')
    expect(result?.models.map((m) => m.id)).toEqual(['a', 'b'])
    expect(call).toBe(2)
  })

  it('returns null on a non-2xx response', async () => {
    mockFetchOnce({}, false)
    expect(await fetchAnthropicModels('sk-test')).toBeNull()
  })

  it('returns null when fetch throws (network error/timeout)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('timeout')) as unknown as typeof fetch
    expect(await fetchAnthropicModels('sk-test')).toBeNull()
  })
})

describe('fetchGoogleModels', () => {
  it('strips the models/ prefix, maps displayName/inputTokenLimit, and the thinking flag', async () => {
    mockFetchOnce({
      models: [
        {
          name: 'models/gemini-3.1-pro-preview',
          displayName: 'Gemini 3.1 Pro',
          inputTokenLimit: 1_000_000,
          thinking: true,
          supportedGenerationMethods: ['generateContent']
        }
      ]
    })
    const result = await fetchGoogleModels('key-test')
    expect(result?.models).toEqual([
      { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', contextWindow: 1_000_000 }
    ])
    expect(result?.capabilities['gemini-3.1-pro-preview']).toEqual({ reasoning: true })
  })

  it('falls back to the stripped id as label when displayName is absent', async () => {
    mockFetchOnce({
      models: [{ name: 'models/some-new-model', supportedGenerationMethods: ['generateContent'] }]
    })
    const result = await fetchGoogleModels('key-test')
    expect(result?.models[0]).toEqual({ id: 'some-new-model', label: 'some-new-model' })
  })

  it('keeps a generateContent-capable entry', async () => {
    mockFetchOnce({
      models: [
        { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] }
      ]
    })
    const result = await fetchGoogleModels('key-test')
    expect(result?.models.map((m) => m.id)).toEqual(['gemini-2.5-flash'])
  })

  it('filters out an embedding-only entry', async () => {
    mockFetchOnce({
      models: [
        { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }
      ]
    })
    const result = await fetchGoogleModels('key-test')
    expect(result?.models).toEqual([])
  })

  it('filters out an entry with no supportedGenerationMethods field at all', async () => {
    mockFetchOnce({ models: [{ name: 'models/some-unknown-shape' }] })
    const result = await fetchGoogleModels('key-test')
    expect(result?.models).toEqual([])
  })

  it('follows nextPageToken pagination', async () => {
    let call = 0
    global.fetch = vi.fn().mockImplementation(() => {
      call++
      if (call === 1) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              models: [{ name: 'models/a', supportedGenerationMethods: ['generateContent'] }],
              nextPageToken: 'page2'
            })
        })
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            models: [{ name: 'models/b', supportedGenerationMethods: ['generateContent'] }]
          })
      })
    }) as unknown as typeof fetch
    const result = await fetchGoogleModels('key-test')
    expect(result?.models.map((m) => m.id)).toEqual(['a', 'b'])
    expect(call).toBe(2)
  })

  it('returns null on a non-2xx response', async () => {
    mockFetchOnce({}, false)
    expect(await fetchGoogleModels('key-test')).toBeNull()
  })
})

describe('fetchOpenAIModels', () => {
  it('filters ids through the injected predicate and labels each by its raw id', async () => {
    mockFetchOnce({
      data: [{ id: 'gpt-5.6-sol' }, { id: 'text-embedding-3-large' }, { id: 'whisper-1' }]
    })
    const result = await fetchOpenAIModels('sk-test', (id) => id.startsWith('gpt-'))
    expect(result?.models).toEqual([{ id: 'gpt-5.6-sol', label: 'gpt-5.6-sol' }])
    expect(result?.capabilities).toEqual({})
  })

  it('returns null on a non-2xx response', async () => {
    mockFetchOnce({}, false)
    expect(await fetchOpenAIModels('sk-test', () => true)).toBeNull()
  })

  it('returns null when fetch throws', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('timeout')) as unknown as typeof fetch
    expect(await fetchOpenAIModels('sk-test', () => true)).toBeNull()
  })
})
