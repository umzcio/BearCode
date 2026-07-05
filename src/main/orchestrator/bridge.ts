// Pure mappers from the orchestrator's accumulated streaming buffers to the
// existing Event contract (src/shared/types.ts). These are UPSERT-by-id: the
// same id is re-emitted with the growing accumulated string on every token,
// exactly like the deleted legacy engine's streamText loop.
import type { Event } from '../../shared/types'

export function textDeltaEvent(id: string, text: string, agentId?: string): Event {
  return agentId
    ? { type: 'assistant_text', id, text, agentId }
    : { type: 'assistant_text', id, text }
}

export function thinkingDeltaEvent(
  id: string,
  text: string,
  durationMs: number,
  agentId?: string
): Event {
  return agentId
    ? { type: 'thinking', id, text, durationMs, agentId }
    : { type: 'thinking', id, text, durationMs }
}
