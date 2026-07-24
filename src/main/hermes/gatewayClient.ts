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
    public readonly kind: 'network' | 'auth' | 'http' | 'stream',
    public readonly status?: number
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
  idempotencyKey: string,
  model: string
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
        model,
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
    throw new HermesGatewayError(
      `Hermes gateway returned HTTP ${response.status}`,
      'http',
      response.status
    )
  }
  if (!response.body) {
    throw new HermesGatewayError('Hermes gateway returned no response body', 'stream')
  }
  return response
}

// vLLM (and most OpenAI-compatible servers) reject a chat request whose `model`
// isn't one they actually serve -- returning 404 "the model does not exist".
// The gateway URL a user points at is frequently a raw vLLM endpoint rather
// than a bespoke Hermes gateway, so we can't assume a fixed model name. Try
// optimistically with DEFAULT_MODEL; on a 404, look up the real model id from
// /v1/models, cache it per gateway, and retry once. A genuine Hermes gateway
// that knows/ignores the model never 404s, so it pays none of this cost.
const DEFAULT_MODEL = 'hermes'
const modelCache = new Map<string, string>()

function gatewayKey(gatewayUrl: string): string {
  return gatewayUrl.replace(/\/$/, '')
}

// Exposed for tests: the model cache is process-global, so a resolved model
// would otherwise leak into later tests hitting the same gateway URL.
export function resetHermesModelCache(): void {
  modelCache.clear()
}

async function resolveServedModel(opts: HermesChatOptions): Promise<string | null> {
  try {
    const headers: Record<string, string> = {}
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`
    const res = await fetch(gatewayUrlFor(opts.gatewayUrl, '/v1/models'), {
      headers,
      signal: opts.signal
    })
    if (!res.ok) return null
    const body = (await res.json()) as { data?: Array<{ id?: string }> }
    return body.data?.[0]?.id ?? null
  } catch {
    // No model list (not an OpenAI-style endpoint, or unreachable) -- let the
    // caller surface the original 404 rather than inventing a model.
    return null
  }
}

async function postWithModelResolution(
  opts: HermesChatOptions,
  idempotencyKey: string
): Promise<Response> {
  const key = gatewayKey(opts.gatewayUrl)
  const model = modelCache.get(key) ?? DEFAULT_MODEL
  try {
    return await postChatCompletion(opts, idempotencyKey, model)
  } catch (err) {
    if (err instanceof HermesGatewayError && err.kind === 'http' && err.status === 404) {
      const resolved = await resolveServedModel(opts)
      if (resolved && resolved !== model) {
        modelCache.set(key, resolved)
        return await postChatCompletion(opts, idempotencyKey, resolved)
      }
    }
    throw err
  }
}

// Single same-idempotency-key retry on a NETWORK failure only (DNS/connection
// reset/timeout) -- never on an HTTP error response (401/403/5xx), which is
// a real answer from the server, not a transient drop.
export async function sendHermesMessage(opts: HermesChatOptions): Promise<void> {
  const idempotencyKey = randomUUID()
  let response: Response
  try {
    response = await postWithModelResolution(opts, idempotencyKey)
  } catch (err) {
    if (err instanceof HermesGatewayError && err.kind === 'network' && !opts.signal.aborted) {
      response = await postWithModelResolution(opts, idempotencyKey)
    } else {
      throw err
    }
  }

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      buffer = parseSseBuffer(buffer, opts.onDelta)
    }
  } catch (err) {
    // A mid-stream disconnect is NOT eligible for the network-failure retry
    // above -- onDelta may already have fired with partial content, so
    // retrying would duplicate/corrupt what the caller has already rendered.
    if (err instanceof HermesGatewayError) throw err
    throw new HermesGatewayError(
      err instanceof Error ? err.message : 'Hermes stream read failed',
      'stream'
    )
  }
}

export async function checkHermesHealth(
  gatewayUrl: string,
  token?: string
): Promise<{ ok: boolean; message: string }> {
  try {
    const headers: Record<string, string> = {}
    if (token) headers['Authorization'] = `Bearer ${token}`
    // Probe /v1/models, NOT /health: /health is unauthenticated, so it returns
    // 200 even with a missing/wrong bearer token -- a false "Connected" that
    // then 401s on the first real chat turn. /v1/models requires auth, so this
    // actually validates the token (it's the gateway docs' own verify command).
    const response = await fetch(gatewayUrlFor(gatewayUrl, '/v1/models'), { headers })
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: 'Rejected — check the bearer token in Settings' }
    }
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
