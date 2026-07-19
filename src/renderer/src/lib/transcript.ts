import type { Event } from '@shared/types'

export interface Turn {
  user: Extract<Event, { type: 'user_message' }>
  steps: Event[]
  texts: Extract<Event, { type: 'assistant_text' }>[]
  diffs: Extract<Event, { type: 'file_diff' }>[]
  artifacts: Extract<Event, { type: 'artifact' }>[]
  errors: Extract<Event, { type: 'error' }>[]
  done: boolean
  // The turn's closing turn_meta event (Ursa Phase 1 Task 11), if it has
  // completed. Carries provider/model/ursaRole for the hover badge -- not set
  // until the turn actually finishes, same moment `done` flips true.
  turnMeta?: Extract<Event, { type: 'turn_meta' }>
}

// A transcript is a stream of turns interleaved with top-level markers. Today
// the only marker is `compaction` (auto-compaction folded the oldest messages
// into a summary); it sits between turns in stream order, like a divider.
export type TranscriptItem =
  { kind: 'turn'; turn: Turn } | { kind: 'compaction'; id: string; summarizedCount: number }

export function groupTurns(events: Event[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  let current: Turn | null = null
  for (const ev of events) {
    if (ev.type === 'user_message') {
      current = {
        user: ev,
        steps: [],
        texts: [],
        diffs: [],
        artifacts: [],
        errors: [],
        done: false
      }
      // Push the live object by reference so later events mutating `current`
      // (steps/texts/done) are reflected in the rendered item.
      items.push({ kind: 'turn', turn: current })
    } else if (ev.type === 'compaction') {
      // Additive & optional: older streams never carry this, so nothing renders.
      items.push({ kind: 'compaction', id: ev.id, summarizedCount: ev.summarizedCount })
    } else if (current) {
      if (
        ev.type === 'thinking' ||
        ev.type === 'tool_call' ||
        ev.type === 'tool_result' ||
        // Ursa Phase 2: pipeline step dividers ride the step stream so they
        // interleave in emit-order with the tool calls/thinking of the step
        // they precede (WorkedGroup renders them as a slim divider row).
        ev.type === 'ursa_step'
      ) {
        current.steps.push(ev)
      } else if (ev.type === 'assistant_text') {
        current.texts.push(ev)
      } else if (ev.type === 'file_diff') {
        current.diffs.push(ev)
      } else if (ev.type === 'artifact') {
        current.artifacts.push(ev)
      } else if (ev.type === 'error') {
        current.errors.push(ev)
      } else if (ev.type === 'turn_meta') {
        current.done = true
        current.turnMeta = ev
      }
    }
  }
  return items
}

export interface TranscriptState {
  events: Event[]
  items: TranscriptItem[]
}

// Reference-equality of an item's underlying events. Turns bucket the SAME
// event objects groupTurns received (no cloning), so two freshly-grouped items
// are "the same" iff every bucketed event is the same object and `done` matches.
export function sameTranscriptItem(a: TranscriptItem, b: TranscriptItem): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'compaction' && b.kind === 'compaction') {
    return a.id === b.id && a.summarizedCount === b.summarizedCount
  }
  if (a.kind === 'turn' && b.kind === 'turn') {
    const x = a.turn,
      y = b.turn
    const arr = (p: Event[], q: Event[]): boolean =>
      p.length === q.length && p.every((e, i) => e === q[i])
    return (
      x.user === y.user &&
      x.done === y.done &&
      x.turnMeta === y.turnMeta &&
      arr(x.steps, y.steps) &&
      arr(x.texts as Event[], y.texts as Event[]) &&
      arr(x.diffs as Event[], y.diffs as Event[]) &&
      arr(x.artifacts as Event[], y.artifacts as Event[]) &&
      arr(x.errors as Event[], y.errors as Event[])
    )
  }
  return false
}

// Rebuild the transcript but preserve object identity for every item unchanged
// since the last build, so finished turns keep stable props and React.memo can
// skip them; only the live tail that actually changed gets fresh objects. (audit H-9)
export function groupTurnsIncremental(
  prev: TranscriptState | null,
  events: Event[]
): TranscriptState {
  if (prev && prev.events === events) return prev
  const fresh = groupTurns(events)
  if (!prev) return { events, items: fresh }
  const items = fresh.map((it, i) => {
    const p = prev.items[i]
    return p && sameTranscriptItem(p, it) ? p : it
  })
  return { events, items }
}
