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
  type SkillProposalResolution,
  type SkillSaveResult
} from '../../shared/types'
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
  resolvePlanInterrupt,
  resolveSkillProposalInterrupt,
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
  sink: RunSink,
  command: CommandRef | null = null,
  mentions: MentionRef[] = [],
  attachments: AttachmentRef[] = []
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
      attachments
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
    if (!resumed) sink.setState(meta.id, 'cancelled')
  }
}
