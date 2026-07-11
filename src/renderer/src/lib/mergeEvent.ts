import type { Event } from '@shared/types'

// Merge a streamed/updated event into the events array. The streaming case
// re-emits under the same id targeting the LAST element, so check the tail
// first (O(1)) before falling back to a findIndex scan. (audit M-18)
export function mergeEvent(events: readonly Event[], event: Event): Event[] {
  const n = events.length
  if (n > 0 && events[n - 1].id === event.id) {
    const next = events.slice(0, n - 1)
    next.push(event)
    return next
  }
  const index = events.findIndex((e) => e.id === event.id)
  if (index === -1) return [...events, event]
  return events.map((e, i) => (i === index ? event : e))
}
