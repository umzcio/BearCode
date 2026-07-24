// Hermes (self-hosted agent) turn runner. When a conversation's modelRef is
// the Hermes sentinel, a turn does NOT go through the LangGraph agent -- it is
// proxied to the Gateway (Task 4's sendHermesMessage) over the conversation's
// existing Hermes session. Mirrors council.ts's runner shape (emit + persist
// through the standard sink/appendEvent pipeline, no new Event types) but is
// much simpler: one streamed answer, no seats/chair/deliberation.
import { randomUUID } from 'crypto'
import { appendEvent, getConversationMeta } from '../db'
import { getSettings } from '../settings'
import { getHermesToken } from '../keys'
import { sendHermesMessage, HermesGatewayError } from '../hermes/gatewayClient'
import { HERMES_MODEL_REF } from '../../shared/types'
import type { RunSink } from '../sink'
import type { Event } from '../../shared/types'

export { HERMES_MODEL_REF }

export function isHermesModelRef(ref: string): boolean {
  return ref === HERMES_MODEL_REF
}

const emitAndPersist = (conversationId: string, sink: RunSink, event: Event): void => {
  sink.emit(conversationId, event)
  appendEvent(conversationId, event)
}

function fail(
  conversationId: string,
  sink: RunSink,
  message: string,
  state: 'error' | 'cancelled' = 'error'
): { paused: boolean; failed: boolean } {
  emitAndPersist(conversationId, sink, {
    type: 'error',
    id: randomUUID(),
    message,
    recoverable: true
  })
  sink.setState(conversationId, state)
  return { paused: false, failed: true }
}

function hermesErrorMessage(err: HermesGatewayError): string {
  switch (err.kind) {
    case 'auth':
      return 'Hermes rejected the connection — check the bearer token in Settings → Hermes.'
    case 'network':
      return `Could not reach the Hermes gateway: ${err.message}`
    default:
      // Covers 'http' and 'stream' (a mid-stream disconnect) alike: neither
      // has a more actionable message than surfacing the gateway's own text.
      return `Hermes gateway error: ${err.message}`
  }
}

export async function runHermes(
  conversationId: string,
  userText: string,
  sink: RunSink,
  signal: AbortSignal
): Promise<{ paused: boolean; failed?: boolean }> {
  const settings = getSettings()
  if (!settings.hermesEnabled || !settings.hermesGatewayUrl) {
    return fail(conversationId, sink, 'Hermes is not configured. Set it up in Settings → Hermes.')
  }

  const meta = getConversationMeta(conversationId)
  const sessionId = meta?.hermesSessionId
  if (!sessionId) {
    return fail(
      conversationId,
      sink,
      'This conversation has no Hermes session. Start a new Hermes conversation.'
    )
  }

  const answerId = randomUUID()
  let answerText = ''
  try {
    await sendHermesMessage({
      gatewayUrl: settings.hermesGatewayUrl,
      token: getHermesToken(),
      sessionId,
      userText,
      signal,
      onDelta: (delta) => {
        answerText += delta
        sink.emit(conversationId, { type: 'assistant_text', id: answerId, text: answerText })
      }
    })
    if (answerText) {
      appendEvent(conversationId, { type: 'assistant_text', id: answerId, text: answerText })
    }
    sink.setState(conversationId, signal.aborted ? 'cancelled' : 'done')
    return { paused: false }
  } catch (err) {
    const cancelled = signal.aborted
    const message = cancelled
      ? 'Cancelled'
      : err instanceof HermesGatewayError
        ? hermesErrorMessage(err)
        : err instanceof Error
          ? err.message
          : 'Hermes request failed'
    return fail(conversationId, sink, message, cancelled ? 'cancelled' : 'error')
  }
}
