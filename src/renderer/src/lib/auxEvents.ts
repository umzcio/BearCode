import type { Event } from '@shared/types'

type SubmitPlanEvent = Extract<Event, { type: 'tool_call' }> & { tool: 'submit_plan' }

export type AuxEvent =
  | Extract<Event, { type: 'artifact' }>
  | Extract<Event, { type: 'file_diff' }>
  | Extract<Event, { type: 'assistant_attachment' }>
  | Extract<Event, { type: 'user_message' }>
  | SubmitPlanEvent

export function isAuxEvent(event: Event): event is AuxEvent {
  return (
    event.type === 'artifact' ||
    event.type === 'file_diff' ||
    event.type === 'assistant_attachment' ||
    event.type === 'user_message' ||
    (event.type === 'tool_call' && event.tool === 'submit_plan')
  )
}

export function projectAuxEvents(events: readonly Event[]): AuxEvent[] {
  return events.filter(isAuxEvent)
}

export function mergeAuxEvent(previous: AuxEvent[], event: Event): AuxEvent[] {
  if (!isAuxEvent(event)) return previous

  const n = previous.length
  if (n > 0 && previous[n - 1].id === event.id) {
    const next = previous.slice(0, n - 1)
    next.push(event)
    return next
  }
  const index = previous.findIndex((candidate) => candidate.id === event.id)
  if (index === -1) return [...previous, event]
  return previous.map((candidate, i) => (i === index ? event : candidate))
}
