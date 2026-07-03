import { randomUUID } from 'crypto'
import type { ConversationMeta, Event } from '../../shared/types'
import type { RunSink } from '../ursa/run'
import { getSettings } from '../settings'
import { appendEvent, getConversationMeta, getZombieRunIds, listConversations } from '../db'
import { cancelPendingApproval, resolveInterrupt, runGraph } from './graph'
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
    const { paused } = await runGraph({
      conversationId,
      userText,
      modelRef,
      sink,
      signal: controller.signal
    })
    // Paused at a command-approval interrupt (risk 4): the run isn't done,
    // it's parked in graph.ts's pendingApprovals until
    // resolveApprovalOrchestrator resumes it. Keep this conversation's
    // AbortController alive (Stop and the approval lookup below both need
    // it) and skip the "run finished" bookkeeping until it actually does.
    if (paused) return
  } catch (err) {
    const cancelled = controller.signal.aborted
    const message = cancelled ? 'Cancelled' : err instanceof Error ? err.message : String(err)
    if (!cancelled) console.error(`[ursa] orchestrator run failed (${modelRef}):`, message)
    const event: Event = { type: 'error', id: randomUUID(), message, recoverable: true }
    sink.emit(conversationId, event)
    appendEvent(conversationId, event)
    sink.setState(conversationId, cancelled ? 'cancelled' : 'error')
  }
  aborts.delete(conversationId)
  const meta = getConversationMeta(conversationId)
  if (meta) sink.metaChanged(meta)
}

// Final-review Critical 1 fix: without this, Stop during a command-approval
// pause was a no-op -- aborting the AbortController alone does nothing,
// because at this point the graph isn't awaiting anything on that signal; it
// is suspended inside a LangGraph interrupt() with its resumable state parked
// in graph.ts's pendingApprovals map (see startRunOrchestrator's `paused`
// comment above and cancelPendingApproval's doc comment in graph.ts). A later
// Approve click would then still resume the graph and actually run the shell
// command. Mirrors legacy run.ts's pattern (abort denies the pending
// approval) adapted to the no-live-promise shape of an interrupt: delete the
// pendingApprovals entry (so a stale Approve/Deny is provably a no-op, see
// resolveInterrupt's `pending.signal.aborted` guard too) and drive this
// conversation to the same terminal 'cancelled' state startRunOrchestrator's
// own catch block produces for a plain mid-stream Stop.
export function cancelRunOrchestrator(conversationId: string): void {
  aborts.get(conversationId)?.abort()
  const sink = cancelPendingApproval(conversationId)
  if (!sink) return
  aborts.delete(conversationId)
  const event: Event = { type: 'error', id: randomUUID(), message: 'Cancelled', recoverable: true }
  sink.emit(conversationId, event)
  appendEvent(conversationId, event)
  sink.setState(conversationId, 'cancelled')
  const meta = getConversationMeta(conversationId)
  if (meta) sink.metaChanged(meta)
}

// Resolves a command-approval interrupt raised by the orchestrator's
// run_command tool (risk 4, src/main/orchestrator/tools.ts +
// src/main/orchestrator/graph.ts's `resolveInterrupt`/`pendingApprovals`).
// Wired from bearcode:tools:approve in src/main/ipc.ts when useOrchestrator()
// is true, mirroring the legacy engine's resolveApproval (src/main/ursa/run.ts).
export function resolveApprovalOrchestrator(callId: string, approved: boolean): void {
  // bearcode:tools:approve (src/main/ipc.ts) only carries a callId, not a
  // conversationId (matching the legacy engine's resolveApproval, which is
  // also keyed globally by callId). `aborts` holds every conversation with a
  // live run, including ones parked awaiting approval (startRunOrchestrator
  // above keeps the AbortController alive across a pause -- it only clears
  // it once the run truly finishes), so trying each is a correct, cheap scan.
  for (const conversationId of aborts.keys()) {
    if (resolveInterrupt(conversationId, callId, approved)) return
  }
}

// Boot-time crash-resume scan (risk 6).
//
// src/main/db/index.ts already guarantees the `events` table (the UI's
// source of truth) never shows a conversation stuck mid-run forever: the
// very first database access on boot -- triggered below by
// `listConversations()` -- synchronously walks every conversation's last
// event and appends a synthetic `{ type: 'error', message: 'Cancelled' }`
// event to any conversation that didn't end in `turn_meta`/`error`
// (`cancelZombieRuns` in db/index.ts). That function returns the exact list
// of conversation IDs it patched, cached and re-exposed via
// `getZombieRunIds()`. This scan consumes that authoritative list directly
// -- it does NOT re-derive "was this dangling" by matching the wording of
// the synthetic event (`message === 'Cancelled'`); that string is an
// internal implementation detail of `cancelZombieRuns` and a live Stop-button
// cancellation happens to write the same shape, so string-matching it here
// would be one rename away from silently breaking this safety net.
//
// For each dangling conversation this cross-checks the SQLite checkpointer
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

// Pure selection: which conversations need the resume scan's cross-check.
// A conversation is dangling if the boot scan patched it (`zombieIds`) and
// it does not already have a live run in this process (`activeIds`) --
// the latter is a narrow TOCTOU guard: if a user re-ran a dangling
// conversation in the moment between boot and this scan reaching it, don't
// flash it back to 'cancelled' out from under the run that just started.
export function selectDanglingConversations(
  metas: ConversationMeta[],
  zombieIds: readonly string[],
  activeIds: ReadonlySet<string> = new Set()
): ConversationMeta[] {
  const zombieSet = new Set(zombieIds)
  return metas.filter((m) => zombieSet.has(m.id) && !activeIds.has(m.id))
}

export async function resumeInterruptedRuns(sink: RunSink): Promise<void> {
  const checkpointer = getCheckpointer()
  const candidates = selectDanglingConversations(
    listConversations(),
    getZombieRunIds(),
    new Set(aborts.keys())
  )
  for (const meta of candidates) {
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
