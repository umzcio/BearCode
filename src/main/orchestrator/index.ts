import { randomUUID } from 'crypto'
import type { Event } from '../../shared/types'
import type { RunSink } from '../ursa/run'
import { getSettings } from '../settings'
import { appendEvent, getConversationMeta } from '../db'
import { runGraph } from './graph'

export function useOrchestrator(): boolean {
  return process.env['BEARCODE_ENGINE'] === 'orchestrator' || getSettings().experimentalEngine
}

const aborts = new Map<string, AbortController>()

export async function startRunOrchestrator(
  conversationId: string,
  userText: string,
  modelRef: string,
  sink: RunSink
): Promise<void> {
  const controller = new AbortController()
  aborts.set(conversationId, controller)
  try {
    await runGraph({ conversationId, userText, modelRef, sink, signal: controller.signal })
  } catch (err) {
    const cancelled = controller.signal.aborted
    const message = cancelled ? 'Cancelled' : err instanceof Error ? err.message : String(err)
    if (!cancelled) console.error(`[ursa] orchestrator run failed (${modelRef}):`, message)
    const event: Event = { type: 'error', id: randomUUID(), message, recoverable: true }
    sink.emit(conversationId, event)
    appendEvent(conversationId, event)
    sink.setState(conversationId, cancelled ? 'cancelled' : 'error')
  } finally {
    aborts.delete(conversationId)
    const meta = getConversationMeta(conversationId)
    if (meta) sink.metaChanged(meta)
  }
}

export function cancelRunOrchestrator(conversationId: string): void {
  aborts.get(conversationId)?.abort()
}
