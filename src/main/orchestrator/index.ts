import { randomUUID } from 'crypto'
import type { ConversationMeta, Event } from '../../shared/types'
import type { RunSink } from '../sink'
import {
  appendEvent,
  getConversationMeta,
  getEvents,
  getZombieRunIds,
  listConversations,
  setModelRef
} from '../db'
import {
  cancelPendingApproval,
  clearAllPendingApprovals,
  forgetPendingApproval,
  rehydratePausedRun,
  resolveInterrupt,
  runGraph,
  setOnResumeSettled
} from './graph'

export { pruneCheckpoints } from './checkpointer'

const aborts = new Map<string, AbortController>()

// Teardown when a conversation is deleted: abort any live run and drop its
// in-memory state (AbortController + any parked approval) without emitting
// events, since the conversation is going away.
export function forgetRunOrchestrator(conversationId: string): void {
  aborts.get(conversationId)?.abort()
  aborts.delete(conversationId)
  forgetPendingApproval(conversationId)
}

// Teardown for a full wipe (clear all conversations).
export function clearRunsOrchestrator(): void {
  for (const [, controller] of aborts) controller.abort()
  aborts.clear()
  clearAllPendingApprovals()
}

// A run parked on approval keeps its AbortController in `aborts` across the
// pause (see startRunOrchestrator's `paused` branch). graph.ts drives the
// resumed run to its terminal state itself (closeOutTurn handles the final
// state + title); this callback fires once that happens so the kept-alive
// controller doesn't leak in the map for the life of the process.
setOnResumeSettled((conversationId) => {
  aborts.delete(conversationId)
})

export async function startRunOrchestrator(
  conversationId: string,
  userText: string,
  modelRef: string,
  sink: RunSink
): Promise<void> {
  // Persist the model on the conversation row (mirrors the legacy engine's
  // run.ts). Beyond restoring the picker on reopen, crash-resume (A2) needs it:
  // rehydratePausedRun rebuilds the agent from meta.modelRef, so without this a
  // paused orchestrator run could never be recovered after a restart.
  setModelRef(conversationId, modelRef)
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

// Resolves ONE command-approval card raised by the run_command tool
// (src/main/orchestrator/tools.ts + graph.ts's `resolveInterrupt`/
// `pendingApprovals`). Wired from bearcode:tools:approve in src/main/ipc.ts.
// A conversation can park several cards at once (parallel tool calls);
// resolveInterrupt records this card's decision and only dispatches the
// batch keyed resume once every card in that conversation is answered -- the
// run stays parked (and its AbortController stays in `aborts`) in between.
export function resolveApprovalOrchestrator(callId: string, approved: boolean): void {
  // bearcode:tools:approve (src/main/ipc.ts) only carries a callId, not a
  // conversationId, so `aborts` holds every conversation with a
  // live run, including ones parked awaiting approval (startRunOrchestrator
  // above keeps the AbortController alive across a pause -- it only clears
  // it once the run truly finishes), so trying each is a correct, cheap scan.
  // Card event ids are uuids, so a callId matches at most one conversation.
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
// For each dangling conversation this attempts a full crash-resume (A2) via
// rehydratePausedRun (graph.ts): rebuild the agent on the persisted checkpoint
// and, if the run died parked at a command-approval interrupt, re-surface the
// approval so the user can Approve/Deny and continue from where it stopped.
// Conversations with no resumable interrupt (a mid-stream crash, which has no
// safe token-stream resume point) fall back to the original degrade-clean
// behavior: broadcast `cancelled` so nothing is ever left reporting
// `running`/`awaiting-approval` against what is durably on disk.

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

// The most recent user_message text for a conversation, used to seed the
// rehydrated DriveContext (title generation on eventual completion). Empty
// string if none -- an established conversation is usually already titled.
function lastUserText(conversationId: string): string {
  const events = getEvents(conversationId)
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'user_message') return e.text
  }
  return ''
}

export async function resumeInterruptedRuns(sink: RunSink): Promise<void> {
  const candidates = selectDanglingConversations(
    listConversations(),
    getZombieRunIds(),
    new Set(aborts.keys())
  )
  for (const meta of candidates) {
    let resumed = false
    if (meta.modelRef) {
      // Register the AbortController BEFORE rehydrating: a re-parked approval
      // needs it live so Stop (cancelRunOrchestrator) and the approval lookup
      // (resolveApprovalOrchestrator's aborts scan) both find this conversation,
      // exactly as a live paused run does.
      const controller = new AbortController()
      aborts.set(meta.id, controller)
      try {
        resumed = await rehydratePausedRun(
          meta.id,
          meta.modelRef,
          lastUserText(meta.id),
          sink,
          controller.signal
        )
      } catch (err) {
        console.error(`[ursa] orchestrator: crash-resume rehydrate failed for ${meta.id}:`, err)
      }
      if (!resumed) aborts.delete(meta.id)
    }
    // Not resumable (no modelRef, no interrupt, or rehydrate failed): degrade
    // clean, exactly as before.
    if (!resumed) sink.setState(meta.id, 'cancelled')
  }
}
