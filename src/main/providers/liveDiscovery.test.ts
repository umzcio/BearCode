import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchAnthropicModels } from './liveDiscovery'

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
