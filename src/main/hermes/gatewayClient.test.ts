import { describe, it, expect, vi, afterEach } from 'vitest'
import { parseSseBuffer, sendHermesMessage, checkHermesHealth } from './gatewayClient'

describe('parseSseBuffer', () => {
  it('extracts content from a complete SSE frame and returns the remainder', () => {
    const deltas: string[] = []
    const remainder = parseSseBuffer(
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\npartial',
      (d) => deltas.push(d)
    )
    expect(deltas).toEqual(['Hel', 'lo'])
    expect(remainder).toBe('partial')
  })

  it('ignores the [DONE] sentinel', () => {
    const deltas: string[] = []
    parseSseBuffer('data: [DONE]\n\n', (d) => deltas.push(d))
    expect(deltas).toEqual([])
  })

  it('drops a garbled JSON frame without throwing', () => {
    const deltas: string[] = []
    expect(() => parseSseBuffer('data: {not json}\n\n', (d) => deltas.push(d))).not.toThrow()
    expect(deltas).toEqual([])
  })

  it('ignores a delta with no content field', () => {
    const deltas: string[] = []
    parseSseBuffer('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', (d) =>
      deltas.push(d)
    )
    expect(deltas).toEqual([])
  })
})

function fakeStreamResponse(chunks: string[], status = 200): Response {
  let i = 0
  const encoder = new TextEncoder()
  return {
    ok: status < 400,
    status,
    body: {
      getReader: () => ({
        read: async () => {
          if (i < chunks.length) {
            const value = encoder.encode(chunks[i])
            i += 1
            return { done: false, value }
          }
          return { done: true, value: undefined }
        }
      })
    }
  } as unknown as Response
}

describe('sendHermesMessage', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('streams accumulated deltas via onDelta and sends the session header', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      fakeStreamResponse(['data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n'])
    )
    global.fetch = fetchSpy as unknown as typeof fetch

    const deltas: string[] = []
    await sendHermesMessage({
      gatewayUrl: 'http://100.1.1.1:8642',
      sessionId: 'sess-1',
      userText: 'hello',
      signal: new AbortController().signal,
      onDelta: (d) => deltas.push(d)
    })

    expect(deltas).toEqual(['Hi'])
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://100.1.1.1:8642/v1/chat/completions')
    expect((init.headers as Record<string, string>)['X-Hermes-Session-Id']).toBe('sess-1')
  })

  it('throws a HermesGatewayError with kind "auth" on 401', async () => {
    global.fetch = vi.fn().mockResolvedValue(fakeStreamResponse([], 401)) as unknown as typeof fetch
    await expect(
      sendHermesMessage({
        gatewayUrl: 'http://x:8642',
        sessionId: 's',
        userText: 'hi',
        signal: new AbortController().signal,
        onDelta: () => {}
      })
    ).rejects.toMatchObject({ kind: 'auth' })
  })

  it('retries once on a network error, then succeeds', async () => {
    const fetchSpy = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(
        fakeStreamResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'])
      )
    global.fetch = fetchSpy as unknown as typeof fetch

    const deltas: string[] = []
    await sendHermesMessage({
      gatewayUrl: 'http://x:8642',
      sessionId: 's',
      userText: 'hi',
      signal: new AbortController().signal,
      onDelta: (d) => deltas.push(d)
    })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(deltas).toEqual(['ok'])
  })

  it('throws HermesGatewayError kind "network" after two consecutive network failures', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNRESET')) as unknown as typeof fetch
    await expect(
      sendHermesMessage({
        gatewayUrl: 'http://x:8642',
        sessionId: 's',
        userText: 'hi',
        signal: new AbortController().signal,
        onDelta: () => {}
      })
    ).rejects.toMatchObject({ kind: 'network' })
  })

  it('throws HermesGatewayError kind "stream" (not "network") when the reader fails mid-stream', async () => {
    const encoder = new TextEncoder()
    let calls = 0
    const midStreamFailingResponse = {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            calls += 1
            if (calls === 1) {
              return {
                done: false,
                value: encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
              }
            }
            throw new Error('socket hang up')
          }
        })
      }
    } as unknown as Response

    const fetchSpy = vi.fn().mockResolvedValue(midStreamFailingResponse)
    global.fetch = fetchSpy as unknown as typeof fetch

    const deltas: string[] = []
    await expect(
      sendHermesMessage({
        gatewayUrl: 'http://x:8642',
        sessionId: 's',
        userText: 'hi',
        signal: new AbortController().signal,
        onDelta: (d) => deltas.push(d)
      })
    ).rejects.toMatchObject({ kind: 'stream' })

    // The first chunk should have already been delivered before the failure --
    // this is precisely why a mid-stream failure must not be retried.
    expect(deltas).toEqual(['partial'])
    // No retry: only the initial fetch, no second connection attempt.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('checkHermesHealth', () => {
  const originalFetch = global.fetch
  afterEach(() => {
    global.fetch = originalFetch
  })

  it('reports ok on a healthy response', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch
    expect(await checkHermesHealth('http://x:8642')).toEqual({ ok: true, message: 'Connected' })
  })

  it('reports not-ok with the status on a non-2xx response', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch
    const result = await checkHermesHealth('http://x:8642')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('503')
  })

  it('reports not-ok when fetch throws', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('unreachable')) as unknown as typeof fetch
    const result = await checkHermesHealth('http://x:8642')
    expect(result.ok).toBe(false)
    expect(result.message).toBe('unreachable')
  })
})
