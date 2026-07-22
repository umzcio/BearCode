import { randomUUID } from 'crypto'
import {
  ATTACHMENT_MIME_TYPES,
  COMMAND_NAME_PATTERN,
  OFFICE_MIME_TYPES,
  PDF_MIME,
  type AttachmentKind,
  type AttachmentRef,
  type CommandRef,
  type ConversationMeta,
  type Event,
  type MentionRef,
  type PlanReviewResolveResult,
  type ReviewLens,
  type SkillProposalResolution,
  type SkillSaveResult
} from '../../shared/types'
import type { RunSink } from '../sink'
import {
  advanceUrsaPipeline,
  appendEvent,
  appendOrReplaceEvent,
  getConversationMeta,
  getEvents,
  getLastResolvedModelRef,
  getUrsaPipeline,
  getZombieRunIds,
  listConversations,
  setModelRef,
  setUrsaPipelineStatus
} from '../db'
import {
  cancelPendingApproval,
  clearAllPendingApprovals,
  forgetPendingApproval,
  rehydratePausedRun,
  resolveInterrupt,
  resolvePlanInterrupt,
  resolveSkillProposalInterrupt,
  runGraph,
  setOnResumeSettled,
  setStartUrsaPipeline
} from './graph'
import { clearBrowserConsent, forgetBrowserConsent } from './tools'

export { pruneCheckpoints } from './checkpointer'

const aborts = new Map<string, AbortController>()

// Teardown when a conversation is deleted: abort any live run and drop its
// in-memory state (AbortController + any parked approval) without emitting
// events, since the conversation is going away.
export function forgetRunOrchestrator(conversationId: string): void {
  aborts.get(conversationId)?.abort()
  aborts.delete(conversationId)
  forgetPendingApproval(conversationId)
  forgetBrowserConsent(conversationId)
}

// Teardown for a full wipe (clear all conversations).
export function clearRunsOrchestrator(): void {
  for (const [, controller] of aborts) controller.abort()
  aborts.clear()
  clearAllPendingApprovals()
  clearBrowserConsent()
}

// A run parked on approval keeps its AbortController in `aborts` across the
// pause (see startRunOrchestrator's `paused` branch). graph.ts drives the
// resumed run to its terminal state itself (closeOutTurn handles the final
// state + title); this callback fires once that happens so the kept-alive
// controller doesn't leak in the map for the life of the process.
//
// Ursa Phase 2 (Task 4): if the run that just settled was a PAUSED PIPELINE
// STEP (a tool-approval inside the step, now resolved and driven to done by
// continueAfterApproval), the pipeline is NOT over -- advance the persisted
// cursor and drive the next step on the SAME kept-alive AbortController. Only
// then (or for any non-pipeline run) do we drop the controller.
setOnResumeSettled((conversationId, sink, failed) => {
  const pipeline = getUrsaPipeline(conversationId)
  if (pipeline && pipeline.status === 'running') {
    // The resumed step ended in error/cancelled: halt the pipeline honestly
    // (mark 'stopped', no zombie 'running' row) rather than advancing into the
    // next step on a failed thread. failTurn already surfaced the terminal
    // state.
    if (failed) {
      setUrsaPipelineStatus(conversationId, 'stopped')
    } else {
      const controller = aborts.get(conversationId)
      if (controller) {
        advanceUrsaPipeline(conversationId)
        void runUrsaPipeline(conversationId, sink, controller.signal)
        return
      }
    }
  }
  aborts.delete(conversationId)
})

// Ursa Modes (Task 6): let graph.ts's deep-research branch start the Phase 2
// pipeline engine directly. runUrsaPipeline lives here (it owns the `aborts`
// map + step loop), and index.ts already imports graph.ts, so this injection
// keeps the single import direction (see setStartUrsaPipeline's doc in graph.ts).
// The deep-research run reuses startRunOrchestrator's kept-alive AbortController
// (graph.ts returns paused:true), so no new controller is registered here --
// unlike resolveUrsaPipelineOrchestrator's approve path, which starts cold.
setStartUrsaPipeline((conversationId, sink, signal) => {
  void runUrsaPipeline(conversationId, sink, signal)
})

export async function startRunOrchestrator(
  conversationId: string,
  userText: string,
  modelRef: string,
  sink: RunSink,
  command: CommandRef | null = null,
  mentions: MentionRef[] = [],
  attachments: AttachmentRef[] = [],
  // Review mode (Phase H, Task 5): a PRE-RESOLVED lens+scope for the
  // re-dispatched run that answers a review_clarify card. Threaded straight
  // through to runGraph's own reviewResolved (see its doc comment in
  // graph.ts) -- everything else about this call is a normal run start.
  // Undefined for every normal send.
  reviewResolved?: { lens: ReviewLens; scope: string }
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
      signal: controller.signal,
      command,
      mentions,
      attachments,
      reviewResolved
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
    if (!cancelled) console.error(`[bearcode] orchestrator run failed (${modelRef}):`, message)
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
export function cancelRunOrchestrator(conversationId: string, sink?: RunSink): void {
  aborts.get(conversationId)?.abort()
  // Ursa Phase 2 (Task 3): Stop while a pipeline PROPOSAL is still awaiting
  // consent. This pause is pre-graph -- no agent, nothing in pendingApprovals,
  // and the AbortController kept alive by startRunOrchestrator's `paused` branch
  // has nothing awaiting it (the abort above is a no-op) -- so the normal
  // cancelPendingApproval path below finds nothing and would leave the run stuck
  // in 'awaiting-approval' forever. Mark the proposal 'stopped', flip its
  // synthetic card to denied, and drive the conversation to 'cancelled', exactly
  // as a real Deny-then-Stop would. A 'running' pipeline (Task 4) is NOT handled
  // here -- its live step drive cancels via the abort signal above.
  const pipeline = getUrsaPipeline(conversationId)
  if (sink && pipeline && pipeline.status === 'proposed') {
    setUrsaPipelineStatus(conversationId, 'stopped')
    const card: Event = {
      type: 'tool_call',
      id: pipeline.callId,
      tool: 'ursa_pipeline',
      input: { steps: pipeline.steps },
      approvalState: 'denied'
    }
    sink.emit(conversationId, card)
    appendOrReplaceEvent(conversationId, card)
    aborts.delete(conversationId)
    const event: Event = {
      type: 'error',
      id: randomUUID(),
      message: 'Cancelled',
      recoverable: true
    }
    sink.emit(conversationId, event)
    appendEvent(conversationId, event)
    sink.setState(conversationId, 'cancelled')
    const meta = getConversationMeta(conversationId)
    if (meta) sink.metaChanged(meta)
    return
  }
  // Ursa Phase 2 (Task 4): Stop while an approved pipeline is RUNNING. Two
  // sub-cases share this mark:
  //  - a step is actively driving: the abort() above cancels its drive signal;
  //    runUrsaPipeline's own catch surfaces the terminal 'cancelled' state and
  //    marks the row 'stopped' (so marking here is a harmless idempotent early
  //    write) -- cancelPendingApproval finds nothing and this returns below.
  //  - a step is PAUSED at a tool-approval interrupt: abort() is a no-op, and
  //    the cancelPendingApproval path below emits 'cancelled' from the parked
  //    sink, but runUrsaPipeline is NOT on the stack to mark the row -- so
  //    marking it 'stopped' HERE is REQUIRED to avoid a zombie 'running' row.
  if (pipeline && pipeline.status === 'running') {
    setUrsaPipelineStatus(conversationId, 'stopped')
  }
  const parkedSink = cancelPendingApproval(conversationId)
  if (!parkedSink) return
  aborts.delete(conversationId)
  const event: Event = { type: 'error', id: randomUUID(), message: 'Cancelled', recoverable: true }
  parkedSink.emit(conversationId, event)
  appendEvent(conversationId, event)
  parkedSink.setState(conversationId, 'cancelled')
  const meta = getConversationMeta(conversationId)
  if (meta) parkedSink.metaChanged(meta)
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

// Ursa Phase 2 (Task 3): resolve a pipeline PROPOSAL (the synthetic
// 'ursa_pipeline' consent card), wired from bearcode:ursa:resolve-pipeline.
// This is entirely self-contained: the card never entered graph.ts's
// pendingApprovals (it is pre-graph, not a LangGraph interrupt), so resolution
// flows ONLY through here -- never through resolveApprovalOrchestrator. The IPC
// carries a conversationId (unlike the callId-only approval scans above),
// because there is no pendingApprovals map to look the conversation up in.
//   - Validates against the persisted proposal: the row must exist, still be
//     'proposed', and its call_id must match the clicked card (a stale click on
//     an already-resolved/stopped proposal, or a mismatched id, is a no-op).
//   - Flips + persists the synthetic card (mirrors finalizeDecision's
//     emit-then-persist, but appendOrReplaceEvent since the pending row is
//     already on disk, and WITHOUT touching pendingApprovals).
//   - Approve  -> status 'running', start the step-execution loop (Task 4).
//   - Deny     -> status 'declined', run the turn single-role on the
//     classifier's fallback model WITHOUT re-classifying (declining is the
//     normal Phase 1 path, never an error).
export function resolveUrsaPipelineOrchestrator(
  conversationId: string,
  callId: string,
  approved: boolean,
  sink: RunSink
): void {
  const pipeline = getUrsaPipeline(conversationId)
  if (!pipeline || pipeline.status !== 'proposed' || pipeline.callId !== callId) return
  const card: Event = {
    type: 'tool_call',
    id: callId,
    tool: 'ursa_pipeline',
    input: { steps: pipeline.steps },
    approvalState: approved ? 'approved' : 'denied'
  }
  sink.emit(conversationId, card)
  appendOrReplaceEvent(conversationId, card)
  if (approved) {
    setUrsaPipelineStatus(conversationId, 'running')
    sink.setState(conversationId, 'running')
    const controller = new AbortController()
    aborts.set(conversationId, controller)
    void runUrsaPipeline(conversationId, sink, controller.signal)
  } else {
    setUrsaPipelineStatus(conversationId, 'declined')
    void runDeclinedPipelineSingleRole(conversationId, sink)
  }
}

// Review mode (Phase H, Task 5): resolve a review_clarify card, wired from
// bearcode:review:resolve-clarify. Unlike a pipeline proposal, a parked
// clarify card is NOT a kept-alive AbortController -- the turn that raised it
// already ran to completion (paused:false, state 'awaiting-approval'; see
// graph.ts's review-mode branch), so there is nothing to resume. Instead this
// starts a brand-new run through the SAME startRunOrchestrator path a normal
// send uses, with reviewResolved set so runGraph skips resolveReviewRequest
// entirely (an answered field is never re-classified/re-asked).
//   - userText is read back from the persisted transcript exactly like
//     runDeclinedPipelineSingleRole's lastUserMessageFull() call above: the
//     original request that raised the clarify card is still the last
//     user_message on this conversation (the clarify card itself isn't one).
//   - modelRef mirrors that same function's getLastResolvedModelRef() read:
//     review mode always resolves and persists a concrete model before it can
//     reach the clarify branch (Ursa/Ursus classification happens up front),
//     so this is never the raw 'ursa/auto' sentinel here.
export function startReviewFromClarification(
  conversationId: string,
  lens: ReviewLens,
  scope: string,
  sink: RunSink
): void {
  const resolvedModelRef = getLastResolvedModelRef(conversationId)
  const last = lastUserMessageFull(conversationId)
  if (!resolvedModelRef) {
    // Mirrors runDeclinedPipelineSingleRole's same-shaped guard: this should be
    // unreachable (the turn that raised the clarify card always persists a
    // resolved model first), but fail honestly rather than guess a role.
    const event: Event = {
      type: 'error',
      id: randomUUID(),
      message: 'Could not recover the model for this review. Try sending the message again.',
      recoverable: true
    }
    sink.emit(conversationId, event)
    appendEvent(conversationId, event)
    sink.setState(conversationId, 'error')
    return
  }
  void startRunOrchestrator(
    conversationId,
    last.text,
    resolvedModelRef,
    sink,
    last.command,
    last.mentions,
    last.attachments,
    { lens, scope }
  )
}

// Ursa Phase 2 (Task 4): the step-execution loop for an approved pipeline. Each
// step is its OWN runGraph({ ursaStep }) call driven on the concrete role model;
// the thread's checkpoint history carries prior steps' work in-context, so no
// manual context plumbing is needed. Entered on approve (from status 'running',
// cursor 0) and re-entered from the onResumeSettled callback after a paused
// step settles (cursor already advanced there). The loop:
//  - drives step `current_step`; on UNPAUSED completion advances the cursor and
//    continues to the next step in the same tick;
//  - on a PAUSED step (a tool-approval interrupt inside it) STOPS looping and
//    returns, leaving the kept-alive AbortController in `aborts` -- resumption
//    flows back through onResumeSettled (which advances + re-enters);
//  - after the last step marks the pipeline 'done' (each step's own closeOutTurn
//    already set the conversation's terminal 'done' run state);
//  - on Stop (signal aborted) or any drive throw marks the pipeline 'stopped'
//    and surfaces the terminal error/cancelled state -- partial work stays in
//    the transcript, honestly labeled, and no further step is started.
export async function runUrsaPipeline(
  conversationId: string,
  sink: RunSink,
  signal: AbortSignal
): Promise<void> {
  const pipeline = getUrsaPipeline(conversationId)
  // Guard: only a 'running' pipeline is drivable. A stale re-entry (Stop flipped
  // it to 'stopped', a crash marked it, etc.) just drops the controller.
  if (!pipeline || pipeline.status !== 'running') {
    aborts.delete(conversationId)
    return
  }
  const steps = pipeline.steps
  // The original request drives step 1's human message; re-read from the
  // persisted user_message (crash-safe, single source of truth).
  const originalUserText = lastUserMessageFull(conversationId).text
  try {
    let completedAll = true
    // Resume from the persisted cursor: fresh approve => 0; a re-entry after a
    // paused step => onResumeSettled already advanced it past the settled step.
    for (let index = pipeline.currentStep; index < steps.length; index++) {
      // Stop landed between steps: halt before starting another.
      if (signal.aborted) {
        setUrsaPipelineStatus(conversationId, 'stopped')
        completedAll = false
        break
      }
      const step = steps[index]
      const { paused, failed } = await runGraph({
        conversationId,
        userText: '',
        modelRef: step.modelRef,
        sink,
        signal,
        ursaStep: {
          index: index + 1,
          total: steps.length,
          role: step.role,
          modelRef: step.modelRef,
          subtask: step.subtask,
          originalUserText
        }
      })
      // Paused inside this step (tool approval): stop the loop. The kept-alive
      // AbortController stays registered; onResumeSettled advances + re-enters
      // once the approval resolves and the step settles.
      if (paused) return
      // A step that ended in error or was cancelled mid-drive shares
      // `paused: false` with a clean completion, but runGraph's own failTurn
      // already surfaced the terminal error/cancelled state. Do NOT advance the
      // cursor or start the next step: mark the pipeline 'stopped' and halt
      // (honest partial result, no zombie 'running' row, no cascade of aborted
      // steps each re-emitting an error).
      if (failed || signal.aborted) {
        setUrsaPipelineStatus(conversationId, 'stopped')
        completedAll = false
        break
      }
      advanceUrsaPipeline(conversationId)
    }
    // Only a run that walked every step without pausing/failing gets here with
    // completedAll still true; a break above already set 'stopped'.
    if (completedAll) setUrsaPipelineStatus(conversationId, 'done')
  } catch (err) {
    // A step drive that threw (e.g. buildAgentAndContext refused a missing
    // worktree) or a Stop mid-step. Either way the pipeline cannot continue:
    // mark it 'stopped' (never leave a zombie 'running' row) and surface the
    // terminal state, mirroring startRunOrchestrator's own catch.
    const cancelled = signal.aborted
    const message = cancelled ? 'Cancelled' : err instanceof Error ? err.message : String(err)
    if (!cancelled) console.error(`[bearcode] ursa pipeline step failed (${conversationId}):`, message)
    setUrsaPipelineStatus(conversationId, 'stopped')
    const event: Event = { type: 'error', id: randomUUID(), message, recoverable: true }
    sink.emit(conversationId, event)
    appendEvent(conversationId, event)
    sink.setState(conversationId, cancelled ? 'cancelled' : 'error')
  }
  aborts.delete(conversationId)
  const meta = getConversationMeta(conversationId)
  if (meta) sink.metaChanged(meta)
}

// The declined-pipeline single-role run (Task 3). Mirrors startRunOrchestrator's
// AbortController + terminal-state bookkeeping, but drives runGraph with
// `ursaResolved` so the turn runs on the classifier's already-persisted fallback
// model WITHOUT re-emitting the user_message and WITHOUT re-classifying (which
// could re-propose the pipeline the user just declined).
async function runDeclinedPipelineSingleRole(
  conversationId: string,
  sink: RunSink
): Promise<void> {
  const resolvedModelRef = getLastResolvedModelRef(conversationId)
  const last = lastUserMessageFull(conversationId)
  if (!resolvedModelRef) {
    // Invariant: resolveTurnModelRef always persists the single-role fallback
    // (setLastResolvedModelRef) BEFORE it can return a pipeline, so this is
    // unreachable in practice. If it somehow is missing, fail honestly rather
    // than re-classify (which risks re-proposing the declined pipeline).
    const event: Event = {
      type: 'error',
      id: randomUUID(),
      message: 'Could not recover the model for the declined pipeline. Try sending the message again.',
      recoverable: true
    }
    sink.emit(conversationId, event)
    appendEvent(conversationId, event)
    sink.setState(conversationId, 'error')
    return
  }
  const controller = new AbortController()
  aborts.set(conversationId, controller)
  try {
    const { paused } = await runGraph({
      conversationId,
      userText: last.text,
      modelRef: resolvedModelRef,
      sink,
      signal: controller.signal,
      command: last.command,
      mentions: last.mentions,
      attachments: last.attachments,
      ursaResolved: { modelRef: resolvedModelRef }
    })
    // A tool-approval interrupt inside the declined turn parks it exactly like
    // any single-role turn; keep the controller alive (Stop + the approval
    // lookup still need it) until it truly settles.
    if (paused) return
  } catch (err) {
    const cancelled = controller.signal.aborted
    const message = cancelled ? 'Cancelled' : err instanceof Error ? err.message : String(err)
    if (!cancelled) {
      console.error(`[bearcode] declined-pipeline single-role run failed (${conversationId}):`, message)
    }
    const event: Event = { type: 'error', id: randomUUID(), message, recoverable: true }
    sink.emit(conversationId, event)
    appendEvent(conversationId, event)
    sink.setState(conversationId, cancelled ? 'cancelled' : 'error')
  }
  aborts.delete(conversationId)
  const meta = getConversationMeta(conversationId)
  if (meta) sink.metaChanged(meta)
}

// The most recent user_message in full (text + command + mentions +
// attachments), used to faithfully re-drive the declined-pipeline turn. The
// proposal path already emitted+persisted this event, so re-reading it (rather
// than re-passing from the IPC) is both crash-safe and avoids a second echo.
function lastUserMessageFull(conversationId: string): {
  text: string
  command: CommandRef | null
  mentions: MentionRef[]
  attachments: AttachmentRef[]
} {
  const events = getEvents(conversationId)
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'user_message') {
      return {
        text: e.text,
        command: e.command ?? null,
        mentions: e.mentions ?? [],
        attachments: e.attachments ?? []
      }
    }
  }
  return { text: '', command: null, mentions: [], attachments: [] }
}

// Wire-boundary guard for bearcode:artifacts:resolve-plan-review (src/main
// /ipc.ts). IPC arguments cross a JS-only bridge with no runtime type
// enforcement despite the handler's TS signature -- a stale preload build, a
// compromised renderer, or a future caller with looser types could send
// something truthy-but-not-`true` for `proceed` or a non-string `message`.
// resolvePlanInterrupt (graph.ts) treats `decision.proceed` as an
// already-trusted boolean and branches on it directly (graph.ts:1451), so
// anything looser than a literal boolean must be rejected HERE, before it
// ever reaches that branch, rather than silently coerced. Exported for
// ipc.ts and for direct unit testing (orchestrator/*.test.ts already mocks
// './graph' + '../db' to exercise this module without a real graph/db).
export function assertValidPlanReviewResolution(proceed: unknown, message: unknown): void {
  if (proceed !== true && proceed !== false) {
    throw new Error('resolvePlanReview: proceed must be a boolean')
  }
  if (message !== undefined && typeof message !== 'string') {
    throw new Error('resolvePlanReview: message must be a string or undefined')
  }
}

// The sendable built-ins (D2 Task 3, design 6.2): `resume` is a pure UI
// action that never reaches run:start and the remaining coming-soon built-ins
// are menu entries only. `compact` is sendable — it forces summarization on
// the turn it is invoked. `browser` (F4) is sendable — it delegates the turn
// to the browser subagent. `learn` (G-skills Task 8) is sendable — it steers
// the turn toward distilling and proposing a skill via propose_skill. Mirrors
// BUILTIN_COMMANDS' status field (commands.ts) without importing it, so this
// boundary check never needs a live AgentsContent to run.
const SENDABLE_BUILTINS = new Set(['goal', 'grill-me', 'compact', 'browser', 'learn', 'remember'])

// Wire-boundary guard for bearcode:run:start's optional `command` argument
// (src/main/ipc.ts). Same posture as assertValidPlanReviewResolution above:
// IPC arguments cross a JS-only bridge with no runtime type enforcement, so a
// stale preload build or a compromised renderer could send anything. A
// workflow name is a REGISTRY LOOKUP (commands.ts resolveWorkflowSteps), never
// a path, so this only needs to bound the shape and grammar before the value
// ever reaches that lookup -- no traversal surface (the activate_rule
// posture, Global Constraints SECURITY). Throws on anything invalid; ipcMain
// .handle turns that into a rejected promise for the renderer, before any DB
// or model work happens.
export function assertValidCommand(command: unknown): CommandRef | null {
  if (command === null || command === undefined) return null
  if (typeof command !== 'object') {
    throw new Error('run:start: command must be an object or null')
  }
  const { kind, name } = command as { kind?: unknown; name?: unknown }
  if (kind !== 'builtin' && kind !== 'workflow') {
    throw new Error('run:start: command.kind must be "builtin" or "workflow"')
  }
  if (typeof name !== 'string' || !COMMAND_NAME_PATTERN.test(name)) {
    throw new Error('run:start: command.name must be a kebab-case command name')
  }
  if (kind === 'builtin' && !SENDABLE_BUILTINS.has(name)) {
    throw new Error(`run:start: /${name} cannot be sent as a command`)
  }
  return { name, kind }
}

// Wire-boundary guard for bearcode:run:start's optional `mentions` argument
// (src/main/ipc.ts). Same posture as assertValidCommand above: IPC arguments
// cross a JS-only bridge with no runtime type enforcement, so a stale preload
// build or compromised renderer could send anything. `mention.path` is used
// ONLY as prompt text (the Referenced-files block) and a pure glob-match
// string (matchesEditPath) — never opened here; the agent reads referenced
// files later through its jailed DiffFsBackend, which re-jails every path. So
// this bounds shape and size only (no traversal check needed). Returns a
// clean MentionRef[] (unknown fields dropped); throws on anything malformed.
export function assertValidMentions(mentions: unknown): MentionRef[] {
  if (mentions === null || mentions === undefined) return []
  if (!Array.isArray(mentions)) {
    throw new Error('run:start: mentions must be an array or null')
  }
  if (mentions.length > 50) {
    throw new Error('run:start: too many mentions')
  }
  return mentions.map((m) => {
    if (typeof m !== 'object' || m === null) {
      throw new Error('run:start: each mention must be an object')
    }
    const { kind, name, path, conversationId } = m as {
      kind?: unknown
      name?: unknown
      path?: unknown
      conversationId?: unknown
    }
    if (kind !== 'file' && kind !== 'rule' && kind !== 'conversation' && kind !== 'connector') {
      throw new Error('run:start: mention.kind must be file, rule, conversation, or connector')
    }
    if (typeof name !== 'string' || name.length === 0 || name.length > 1024) {
      throw new Error('run:start: mention.name must be a non-empty string')
    }
    if (path !== undefined && typeof path !== 'string') {
      throw new Error('run:start: mention.path must be a string')
    }
    if (conversationId !== undefined && typeof conversationId !== 'string') {
      throw new Error('run:start: mention.conversationId must be a string')
    }
    const ref: MentionRef = { kind, name }
    if (typeof path === 'string') ref.path = path
    if (typeof conversationId === 'string') ref.conversationId = conversationId
    return ref
  })
}

// Wire-boundary guard for bearcode:run:start's optional `attachments` argument
// (src/main/ipc.ts). SAME posture as assertValidMentions above, PLUS an id
// path-safety check that mentions do not need: an AttachmentRef.id is used
// main-side to build the on-disk read path userData/attachments/<convId>/<id>,
// so a stale preload or compromised renderer must not be able to smuggle a
// traversal segment ('..', '/', '\', '.') through it. Bounds shape, count
// (design's 5-per-message cap), mime allowlist, and id grammar; throws on
// anything malformed. Returns a clean AttachmentRef[] (unknown fields dropped).
const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const ATTACHMENT_KINDS: AttachmentKind[] = ['image', 'text', 'pdf', 'office']
function isSupportedAttachmentMime(mime: string): boolean {
  return (
    (ATTACHMENT_MIME_TYPES as readonly string[]).includes(mime) ||
    mime === PDF_MIME ||
    (OFFICE_MIME_TYPES as readonly string[]).includes(mime) ||
    mime.startsWith('text/')
  )
}
export function assertValidAttachments(attachments: unknown): AttachmentRef[] {
  if (attachments === null || attachments === undefined) return []
  if (!Array.isArray(attachments)) {
    throw new Error('run:start: attachments must be an array or null')
  }
  if (attachments.length > 5) {
    throw new Error('run:start: too many attachments (max 5 per message)')
  }
  return attachments.map((a) => {
    if (typeof a !== 'object' || a === null) {
      throw new Error('run:start: each attachment must be an object')
    }
    const { id, name, mime, kind } = a as {
      id?: unknown
      name?: unknown
      mime?: unknown
      kind?: unknown
    }
    if (typeof id !== 'string' || !ATTACHMENT_ID_PATTERN.test(id)) {
      throw new Error('run:start: attachment.id must match /^[A-Za-z0-9_-]{1,64}$/')
    }
    if (typeof name !== 'string' || name.length === 0 || name.length > 1024) {
      throw new Error('run:start: attachment.name must be a non-empty string')
    }
    if (typeof mime !== 'string' || !isSupportedAttachmentMime(mime)) {
      throw new Error('run:start: attachment.mime is not a supported type')
    }
    // Additive back-compat: a pre-D5 persisted ref that gets re-sent has no
    // kind -> default 'image' (its mime is always an image mime).
    const resolvedKind: AttachmentKind = kind === undefined ? 'image' : (kind as AttachmentKind)
    if (!ATTACHMENT_KINDS.includes(resolvedKind)) {
      throw new Error('run:start: attachment.kind is not a supported kind')
    }
    return { id, name, mime, kind: resolvedKind }
  })
}

// Resolves ONE plan-review card (bearcode:artifacts:resolve-plan-review).
// Same scan idiom as resolveApprovalOrchestrator above: the IPC payload
// carries only a callId, so `aborts` holds every conversation with a live or
// parked run. The discriminant rides through so the renderer can tell the
// user WHY a resolution failed instead of silently no-opping: 'stale' only
// when NO conversation recognized the card ('needs-substance' comes from the
// one conversation that did -- callIds are uuids, so at most one matches).
export function resolvePlanReviewOrchestrator(
  callId: string,
  proceed: boolean,
  message?: string
): PlanReviewResolveResult {
  for (const conversationId of aborts.keys()) {
    const result = resolvePlanInterrupt(conversationId, callId, { proceed, message })
    if (result !== 'stale') return result
  }
  return 'stale'
}

// Resolves ONE propose_skill card (bearcode:skills:save, G-skills Task 8).
// Same scan idiom as resolvePlanReviewOrchestrator above: the IPC payload
// carries only a callId, so `aborts` holds every conversation with a live or
// parked run.
export function resolveSkillProposalOrchestrator(
  callId: string,
  resolution: SkillProposalResolution
): SkillSaveResult {
  for (const conversationId of aborts.keys()) {
    const result = resolveSkillProposalInterrupt(conversationId, callId, resolution)
    if (result !== 'stale') return result
  }
  return 'stale'
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

// The most recent user_message (text + command) for a conversation, used to
// seed the rehydrated DriveContext (title generation on eventual completion)
// and, for `command`, to rebuild the same command prompt additions a paused
// `/workflow` or `/goal` turn started with (D2 Task 3 crash-resume
// threading) -- otherwise the resumed prompt would silently lose them. A
// pre-D2 event has no `command` field, so `?? null` threads unchanged
// behavior for every conversation that predates this feature. Empty text/
// null command if there is no user_message at all -- an established
// conversation is usually already titled.
function lastUserMessage(conversationId: string): { text: string; command: CommandRef | null } {
  const events = getEvents(conversationId)
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'user_message') return { text: e.text, command: e.command ?? null }
  }
  return { text: '', command: null }
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
        const lastUser = lastUserMessage(meta.id)
        resumed = await rehydratePausedRun(
          meta.id,
          meta.modelRef,
          lastUser.text,
          lastUser.command,
          sink,
          controller.signal
        )
      } catch (err) {
        console.error(`[bearcode] orchestrator: crash-resume rehydrate failed for ${meta.id}:`, err)
      }
      if (!resumed) aborts.delete(meta.id)
    }
    // Not resumable (no modelRef, no interrupt, or rehydrate failed): degrade
    // clean, exactly as before.
    if (!resumed) {
      // Ursa Phase 2 (Task 4): a pipeline caught mid-step by the crash with no
      // resumable checkpoint cannot honestly re-run -- mark it 'stopped' so it is
      // never left a zombie 'running' row (a resumable one is left 'running' and
      // advances normally through onResumeSettled once its re-parked step
      // settles). Silent no-op for conversations with no pipeline.
      const pipeline = getUrsaPipeline(meta.id)
      if (pipeline && pipeline.status === 'running') {
        setUrsaPipelineStatus(meta.id, 'stopped')
      } else if (pipeline && pipeline.status === 'proposed') {
        // Ursa Phase 2 (Task 3): a pipeline PROPOSAL caught mid-consent by the
        // crash. The synthetic pending card is durable but the proposal never
        // entered the interrupt machinery (it is pre-graph), so there is nothing
        // to rehydrate -- and leaving the row 'proposed' is dangerous: this
        // conversation is about to degrade to 'cancelled' (below), re-enabling
        // the composer, and resolveUrsaPipelineOrchestrator still accepts an
        // Approve on a 'proposed' row. Approving the stale pinned card AFTER a
        // fresh run had started would overwrite the live run's AbortController
        // (aborts.set) and drive a second pipeline concurrently on the same
        // checkpointer thread. Neutralize it here exactly as a Stop-during-
        // proposal does (cancelRunOrchestrator): mark 'stopped' and flip the
        // persisted card to 'denied', so the resolve guard (status must be
        // 'proposed') makes any later Approve a provable no-op.
        setUrsaPipelineStatus(meta.id, 'stopped')
        const card: Event = {
          type: 'tool_call',
          id: pipeline.callId,
          tool: 'ursa_pipeline',
          input: { steps: pipeline.steps },
          approvalState: 'denied'
        }
        sink.emit(meta.id, card)
        appendOrReplaceEvent(meta.id, card)
      }
      sink.setState(meta.id, 'cancelled')
    }
  }
}
