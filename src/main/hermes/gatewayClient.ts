import { randomUUID } from 'crypto'

export interface HermesChatOptions {
  gatewayUrl: string
  token?: string
  sessionId: string
  userText: string
  signal: AbortSignal
  onDelta: (text: string) => void
}

export class HermesGatewayError extends Error {
  constructor(
    message: string,
    public readonly kind: 'network' | 'auth' | 'http' | 'stream'
  ) {
    super(message)
    this.name = 'HermesGatewayError'
  }
}

// One bad/partial SSE frame must never kill an otherwise-good stream -- drop
// it silently and keep reading. Returns the unconsumed remainder so the
// caller can prepend it to the next chunk (frames can split across reads).
export function parseSseBuffer(buffer: string, onDelta: (text: string) => void): string {
  const frames = buffer.split('\n\n')
  const remainder = frames.pop() ?? ''
  for (const raw of frames) {
    const line = raw.trim()
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '[DONE]') continue
    try {
      const parsed = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string } }>
      }
      const content = parsed.choices?.[0]?.delta?.content
      if (content) onDelta(content)
    } catch {
      // garbled frame -- drop, don't throw
    }
  }
  return remainder
}

function gatewayUrlFor(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}${path}`
}

async function postChatCompletion(
  opts: HermesChatOptions,
  idempotencyKey: string
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Hermes-Session-Id': opts.sessionId,
    'Idempotency-Key': idempotencyKey
  }
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`

  let response: Response
  try {
    response = await fetch(gatewayUrlFor(opts.gatewayUrl, '/v1/chat/completions'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'hermes',
        stream: true,
        messages: [{ role: 'user', content: opts.userText }]
      }),
      signal: opts.signal
    })
  } catch (err) {
    throw new HermesGatewayError(
      err instanceof Error ? err.message : 'Network error reaching the Hermes gateway',
      'network'
    )
  }
  if (response.status === 401 || response.status === 403) {
    throw new HermesGatewayError('Hermes gateway rejected the bearer token', 'auth')
  }
  if (!response.ok) {
    throw new HermesGatewayError(`Hermes gateway returned HTTP ${response.status}`, 'http')
  }
  if (!response.body) {
    throw new HermesGatewayError('Hermes gateway returned no response body', 'stream')
  }
  return response
}

// Single same-idempotency-key retry on a NETWORK failure only (DNS/connection
// reset/timeout) -- never on an HTTP error response (401/403/5xx), which is
// a real answer from the server, not a transient drop.
export async function sendHermesMessage(opts: HermesChatOptions): Promise<void> {
  const idempotencyKey = randomUUID()
  let response: Response
  try {
    response = await postChatCompletion(opts, idempotencyKey)
  } catch (err) {
    if (err instanceof HermesGatewayError && err.kind === 'network' && !opts.signal.aborted) {
      response = await postChatCompletion(opts, idempotencyKey)
    } else {
      throw err
    }
  }

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    buffer = parseSseBuffer(buffer, opts.onDelta)
  }
}

export async function checkHermesHealth(
  gatewayUrl: string,
  token?: string
): Promise<{ ok: boolean; message: string }> {
  try {
    const headers: Record<string, string> = {}
    if (token) headers['Authorization'] = `Bearer ${token}`
    const response = await fetch(gatewayUrlFor(gatewayUrl, '/health'), { headers })
    return response.ok
      ? { ok: true, message: 'Connected' }
      : { ok: false, message: `Gateway returned HTTP ${response.status}` }
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Could not reach the Hermes gateway'
    }
  }
}
