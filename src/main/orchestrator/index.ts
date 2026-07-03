import { randomUUID } from 'crypto'
import type { Event } from '../../shared/types'
import type { RunSink } from '../ursa/run'
import { getSettings } from '../settings'
import { appendEvent, getConversationMeta, getEvents, listConversations } from '../db'
import { runGraph } from './graph'
import { getCheckpointer } from './checkpointer'

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

// Boot-time crash-resume scan (risk 6).
//
// src/main/db/index.ts already guarantees the `events` table (the UI's
// source of truth) never shows a conversation stuck mid-run forever: the
// very first database access on boot -- triggered below by
// `listConversations()` -- synchronously walks every conversation's last
// event and appends a synthetic `{ type: 'error', message: 'Cancelled' }`
// event to any conversation that didn't end in `turn_meta`/`error`
// (`cancelZombieRuns` in db/index.ts). A live Stop-button cancellation
// writes that exact same `{ error, message: 'Cancelled' }` shape (see
// `cancelRunOrchestrator`'s caller in `startRunOrchestrator` and the legacy
// equivalent in `ursa/run.ts`). So "last event is that Cancelled marker"
// reliably identifies every conversation that is not cleanly finished,
// whether it was closed live moments ago or just synthesized after a crash
// on this very boot.
//
// For each such conversation this cross-checks the SQLite checkpointer
// (a SEPARATE store from `events`, see checkpointer.ts) via `getTuple`: if
// LangGraph persisted execution state for that conversation's thread_id,
// that proves the checkpointer round-trips (written during the run, read
// back on the next boot) -- the exact mechanism a real resume would read
// from. Actually replaying execution from that checkpoint is deferred to
// Task 6, which adds a well-defined pause point (the command-approval
// interrupt) to resume from; a bare token-streaming run (this task's graph
// has no tools/interrupt yet) has no safe mid-stream resumption point.
// So today this scan's job is only the safety guarantee: make sure nothing
// is ever left reporting `running`/`awaiting-approval` by (re)broadcasting
// `cancelled` for every affected conversation, so a live renderer's state
// can never disagree with what's durably on disk.
export async function resumeInterruptedRuns(sink: RunSink): Promise<void> {
  const checkpointer = getCheckpointer()
  for (const meta of listConversations()) {
    const events = getEvents(meta.id)
    const last = events[events.length - 1]
    const isDanglingMarker =
      last?.type === 'error' && last.message === 'Cancelled' && last.recoverable
    if (!isDanglingMarker) continue

    try {
      const tuple = await checkpointer.getTuple({ configurable: { thread_id: meta.id } })
      if (tuple) {
        console.log(
          `[ursa] orchestrator: resumeInterruptedRuns found a checkpoint for conversation ` +
            `${meta.id} (checkpoint_id=${String(tuple.config.configurable?.['checkpoint_id'])}); ` +
            'resume-from-checkpoint execution lands in Task 6 (interrupt-based pause point). ' +
            'Marking cancelled so it is never left running.'
        )
      }
    } catch (err) {
      console.error(`[ursa] orchestrator: checkpointer.getTuple failed for ${meta.id}:`, err)
    }

    sink.setState(meta.id, 'cancelled')
  }
}
