// The orchestrator's one custom tool: run_command. Everything else (reading,
// writing, editing, listing, searching) is a Deep Agents built-in tool routed
// through the custom filesystem backend (fsBackend.ts). run_command has no
// built-in equivalent, so it is added explicitly and gated behind the rules
// engine (Bb2): evaluateCommandForConversation(command, conversationId,
// projectPath) checks deny/allow/ask rules first, falling back to the
// conversation's permission mode. A 'block' decision returns a plain string
// with no interrupt. A 'prompt' decision calls `interrupt()` to pause the
// graph (verified pattern: planning/replatform-api-notes.md section (d2),
// node_modules/@langchain/langgraph/dist/interrupt.d.ts) and the resolved
// `resume` value is what the promise returned by `interrupt()` evaluates to
// once the graph is re-invoked with `new Command({ resume })`.
//
// The shell-execution body below is the jailed run_command implementation:
// same shell, timeout/kill, and output-truncation behavior the engine has
// always used.
import { spawn } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { interrupt } from '@langchain/langgraph'
import { tool } from 'langchain'
import { z } from 'zod'
import type { Artifact, Event } from '../../shared/types'
import { appendOrReplaceEvent } from '../db'
import {
  approvePlanArtifact,
  createPlanArtifact,
  createWalkthroughArtifact
} from '../artifacts/store'
import {
  evaluateCommandForConversation,
  evaluateEditForConversation,
  resolveConversationMode
} from '../permissions'
import { loadAgentsContent } from '../agentsDir'
import type { RunSink } from '../sink'
import {
  jailPath,
  relForGate,
  normalizeWorktreeMappings,
  worktreeWritePath,
  worktreeCommandCwd
} from './fsBackend'
import type { WorktreeMapping } from '../worktree/paths'
import { generateDocument, type DocFormat } from '../docgen/generate'
import { docGenGateMessage } from '../docgen/gate'
import { recordBinaryCreation } from '../diffs'
import { getSettings } from '../settings'
import { browserManager } from '../browser/manager'
import { evaluateBrowserAction, browserActionLabel } from '../browser/guard'
import type { DomainPolicy } from '../browser/policy'

const commandSchema = z.object({
  command: z.string().describe('Shell command to run in the workspace folder.'),
  timeoutMs: z.number().int().min(1000).max(600000).optional().describe('Timeout, default 60s.')
})

const artifactSchema = z.object({
  title: z.string().describe('A short, human-readable title for the artifact.'),
  body: z.string().describe('The full artifact content, as markdown.')
})

const activateRuleSchema = z.object({
  name: z.string().describe('The rule name from the Available rules index.')
})

// Denied-replay pins: execution-layer enforcement of a Denied approval card.
// On a keyed resume, LangGraph replays each interrupted task from the top, so
// this tool re-runs evaluateCommandForConversation BEFORE the interrupt() call
// that would return the { approved: false } resume value. Anything that flips
// the decision to 'run' between pause and dispatch -- an "always allow" rule
// saved from a sibling card, or a permission-mode change to 'auto' -- would
// skip interrupt() entirely and execute a command the user explicitly denied.
// graph.ts's continueAfterApproval therefore pins every denied card here right
// before dispatching the batch resume (and clears the pins once the resumed
// segment settles); the tool consults the pins first, so a recorded denial
// always wins over a re-evaluation. Bb3's gated write_file/edit_file replays
// the same way (fsBackend.ts GatedDiffFsBackend.gate) and consults the same
// per-conversation pin set via takeDeniedEditReplayPin below.
//
// Pins are keyed by the provider tool-call id when the approval card knew it
// (the normal case: the interrupt payload carries it), falling back to a
// per-kind string multiset for cards without one (pre-toolCallId checkpoints,
// where the replayed call's config carries no id either): the command string
// for run_command cards, the RAW agent path for write/edit cards. The two
// fallback namespaces are separate so a denied command whose string equals a
// path (or vice versa) can never cross-claim. Take-once semantics: a consumed
// pin is deleted so a later, genuinely new call that happens to reuse a
// provider tool-call id (non-Anthropic providers can) or repeat the command
// string / path is never silently denied.
interface DeniedPinSet {
  byToolCallId: Set<string>
  byCommand: Map<string, number>
  byEditPath: Map<string, number>
  byBrowserAction: Map<string, number>
}
const deniedReplayPins = new Map<string, DeniedPinSet>()

export function pinDeniedReplays(
  conversationId: string,
  pins: ReadonlyArray<{
    toolCallId?: string
    command?: string
    editPath?: string
    browserAction?: string
  }>
): void {
  if (pins.length === 0) return
  const set: DeniedPinSet = {
    byToolCallId: new Set(),
    byCommand: new Map(),
    byEditPath: new Map(),
    byBrowserAction: new Map()
  }
  for (const pin of pins) {
    if (pin.toolCallId !== undefined) {
      set.byToolCallId.add(pin.toolCallId)
    } else if (pin.command !== undefined) {
      set.byCommand.set(pin.command, (set.byCommand.get(pin.command) ?? 0) + 1)
    } else if (pin.editPath !== undefined) {
      set.byEditPath.set(pin.editPath, (set.byEditPath.get(pin.editPath) ?? 0) + 1)
    } else if (pin.browserAction !== undefined) {
      set.byBrowserAction.set(
        pin.browserAction,
        (set.byBrowserAction.get(pin.browserAction) ?? 0) + 1
      )
    }
  }
  deniedReplayPins.set(conversationId, set)
}

export function clearDeniedReplayPins(conversationId: string): void {
  deniedReplayPins.delete(conversationId)
}

// True (and consumes the pin) when this call was denied by the user. The
// command-string fallback is consulted ONLY when the call carries no
// toolCallId: a pin stored under a toolCallId must never be claimable by an
// identical sibling command, and vice versa -- an id-less pin belongs to an
// id-less replay (the interrupt payload and the replayed config get the id
// from the same ToolNode mechanism, so presence always matches).
export function takeDeniedReplayPin(
  conversationId: string,
  toolCallId: string | undefined,
  command: string
): boolean {
  const set = deniedReplayPins.get(conversationId)
  if (!set) return false
  if (toolCallId !== undefined) return set.byToolCallId.delete(toolCallId)
  const n = set.byCommand.get(command)
  if (n === undefined) return false
  if (n <= 1) set.byCommand.delete(command)
  else set.byCommand.set(command, n - 1)
  return true
}

// The write/edit analog of takeDeniedReplayPin, consulted by
// GatedDiffFsBackend.gate (fsBackend.ts) at the top of every replayed
// write/edit. Same discipline: byToolCallId is exact and take-once; the
// raw-path multiset is consulted ONLY for id-less calls, and lives in its
// own namespace (byEditPath, never byCommand) so command and edit pins can
// never cross-claim. rawPath is the string the model sent -- the pin was
// stored from the same raw string (graph.ts deniedReplayPinsOf), so the
// match happens pre-jail, verbatim.
export function takeDeniedEditReplayPin(
  conversationId: string,
  toolCallId: string | undefined,
  rawPath: string
): boolean {
  const set = deniedReplayPins.get(conversationId)
  if (!set) return false
  if (toolCallId !== undefined) return set.byToolCallId.delete(toolCallId)
  const n = set.byEditPath.get(rawPath)
  if (n === undefined) return false
  if (n <= 1) set.byEditPath.delete(rawPath)
  else set.byEditPath.set(rawPath, n - 1)
  return true
}

// The browser analog of takeDeniedReplayPin, consulted at the TOP of
// gateBrowserAction (before the block/prompt/consent decision) so a Denied
// browser card always wins over any decision flip between park and keyed-resume
// replay. The flip vectors this closes: the conversation's first parallel
// mutations approve one and deny the other while the folded session-consent
// prompt is parked (the approved task grants consent, so the denied task would
// otherwise replay in auto mode with consent already cached and never
// interrupt); a mode change (ask→auto) with consent already granted; and a
// navigate whose origin the user adds to the allowlist while its prompt is
// parked. Same discipline as the command/edit takes: byToolCallId is exact and
// take-once; the id-less fallback lives in its OWN namespace (byBrowserAction,
// never byCommand/byEditPath) so a browser action string can never cross-claim
// a command or path pin. `action` is browserActionLabel(tool, input) — the same
// string graph.ts deniedReplayPinsOf stored the pin under.
export function takeDeniedBrowserReplayPin(
  conversationId: string,
  toolCallId: string | undefined,
  action: string
): boolean {
  const set = deniedReplayPins.get(conversationId)
  if (!set) return false
  if (toolCallId !== undefined) return set.byToolCallId.delete(toolCallId)
  const n = set.byBrowserAction.get(action)
  if (n === undefined) return false
  if (n <= 1) set.byBrowserAction.delete(action)
  else set.byBrowserAction.set(action, n - 1)
  return true
}

// The truthy resume-object contract for a plan_review interrupt (design 3.1).
// BOTH variants are truthy objects -- LangGraph's mapCommand drops falsy
// resume values (see the run_command interrupt comment below). `comments` on
// the proceed variant is the user's drafted comments rendered as markdown,
// delivered as steering context in the tool's return (design 3.6 Proceed).
export type PlanReviewResolution =
  { proceed: true; comments?: string } | { proceed: false; feedback: string }

// Design 5: one plan review pause at a time per conversation ("cannot stack
// reviews"). Entered BEFORE the pending row is created, so when the model
// issues two parallel submit_plan calls the loser records nothing at all.
// Keyed by artifactId so a REPLAY of the paused submission (live keyed resume
// or crash-rehydration re-executes the tool from the top) re-enters its own
// slot. Cleared when the interrupt resolves (both branches), on the
// always-proceed bypass, and by graph.ts on Stop/forget/clear-all and at the
// start of every new turn -- a stale slot left by a stopped pause must never
// block a later legitimate submission.
const planReviewInFlight = new Map<string, string>()

export function tryEnterPlanReview(conversationId: string, artifactId: string): boolean {
  const existing = planReviewInFlight.get(conversationId)
  if (existing !== undefined && existing !== artifactId) return false
  planReviewInFlight.set(conversationId, artifactId)
  return true
}

export function clearPlanReviewPending(conversationId: string): void {
  planReviewInFlight.delete(conversationId)
}

export function clearAllPlanReviewPending(): void {
  planReviewInFlight.clear()
}

// F4 L1 session consent: the first browser navigation/mutation in a
// conversation prompts once ("allow BearCode to drive a browser here?"), folded
// into that first prompt; the grant is cached here per conversation so no later
// browser action re-prompts for consent. Module-level (not per-buildTools) so it
// survives across turns for the conversation's lifetime, exactly like
// planReviewInFlight above. Reads run free and never touch this — consent
// attaches to navigate/mutate only (design §L1: one prompt per conversation).
const browserSessionConsent = new Set<string>()

// Test-only reset (mirrors clearAllPlanReviewPending); also useful if a
// conversation is cleared. Never called on the hot path.
export function clearBrowserConsent(): void {
  browserSessionConsent.clear()
}

const BROWSER_DISABLED_MESSAGE = 'Browser tool is disabled in Settings — enable it and relaunch.'

function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number
): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolvePromise) => {
    const child = spawn('/bin/zsh', ['-lc', command], { cwd, detached: true })
    let out = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid!, 'SIGKILL') // kill the whole tree
      } catch {
        child.kill('SIGKILL')
      }
    }, timeoutMs)
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (out += d.toString()))
    child.on('close', (code) => {
      clearTimeout(timer)
      if (out.length > 50000) out = out.slice(0, 50000) + '\n… output truncated'
      if (timedOut) out += `\n(command timed out after ${timeoutMs}ms and was killed)`
      resolvePromise({ output: out || '(no output)', exitCode: code ?? -1 })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolvePromise({ output: `Failed to start command: ${err.message}`, exitCode: -1 })
    })
  })
}

// buildTools(projectPath, conversationId, sink, diffGroupId) returns the LangChain tool array
// passed to createDeepAgent's `tools` option (in addition to its always-on built-ins).
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Zod-inferred `tool()` return type is not writable by hand without narrowing away the actual generic
export function buildTools(
  projectPath: string,
  conversationId: string,
  sink: RunSink,
  diffGroupId: string,
  worktreeMappings: WorktreeMapping[] = []
) {
  // F3: in worktree mode run_command + generate_document must honor the same
  // repo→worktree routing the DiffFsBackend applies to write_file/edit_file, or
  // shell commands and generated docs silently read/write the user's REAL
  // project tree. Normalize once (realpath the repoPaths) so matching lines up
  // with jailPath's realpath'd output. Empty in local mode → byte-identical to
  // pre-F3 behavior.
  const worktrees = normalizeWorktreeMappings(worktreeMappings)
  const runCommandTool = tool(
    async (
      { command, timeoutMs }: { command: string; timeoutMs?: number },
      config?: unknown
    ): Promise<string> => {
      const toolCallId = (config as { toolCallId?: string } | null | undefined)?.toolCallId
      // BEFORE re-evaluating the rules: on a keyed-resume replay a recorded
      // Denied decision must win even when a rule saved from a sibling card
      // (or a mode flip) would now evaluate this command to 'run' and skip
      // the interrupt() below -- see deniedReplayPins' doc comment.
      if (takeDeniedReplayPin(conversationId, toolCallId, command)) {
        return 'User denied this command.'
      }
      const decision = evaluateCommandForConversation(command, conversationId, projectPath)
      if (decision === 'block') {
        // 'block' means either a deny rule OR plan-mode read-only. Re-read the
        // mode live to tell the agent WHY it was blocked (mode-picker design §5).
        return resolveConversationMode(conversationId) === 'plan'
          ? 'Plan mode is read-only; submit a plan and wait for approval before editing or running commands.'
          : 'This command was blocked by a permission rule.'
      }
      if (decision === 'prompt') {
        // Resume value must be wrapped in a truthy object, not a bare
        // boolean: LangGraph's mapCommand (pregel/io.js) guards resume
        // handling with `if (cmd.resume)`, so `Command({ resume: false })`
        // is indistinguishable from no resume at all and throws
        // EmptyInputError("Received empty Command input") -- verified live
        // (node_modules/@langchain/langgraph/dist/pregel/io.js).
        //
        // toolCallId: langchain's ToolNode invokes each tool with a config
        // carrying the provider tool-call id (ToolNode.js runTool:
        // `toolCallId: toolCall.id`), and ensureConfig/patchConfig preserve
        // the extra key down to this function's second argument. Carrying it
        // in the interrupt payload lets graph.ts pair every pending interrupt
        // to its exact tool_call event -- required for parallel approvals,
        // where two identical commands would otherwise be ambiguous.
        const approval = interrupt({
          kind: 'run_command',
          command,
          toolCallId
        }) as { approved: boolean }
        if (!approval.approved) return 'User denied this command.'
      }
      // decision === 'run' (or approved): fall through and execute.
      // F3: in worktree mode run inside the project root's worktree so shell
      // edits/builds/tests stay isolated from the real project tree (loose /
      // child-repo-only projects fall back to the real project folder).
      const cwd = worktreeCommandCwd(projectPath, worktrees)
      const result = await runCommand(command, cwd, timeoutMs ?? 60000)
      const truncated = result.output.length > 50000
      return (
        `exit code ${result.exitCode}\n${result.output}` + (truncated ? '\n… output truncated' : '')
      )
    },
    {
      name: 'run_command',
      description:
        'Run a shell command in the workspace folder. Output is stdout+stderr combined. The user may need to approve the command first.',
      schema: commandSchema
    }
  )

  // Deterministic ids keyed on the provider tool-call id (the same config
  // field run_command reads, above) PLUS a content hash. Two properties, both
  // load-bearing:
  //
  // (1) REPLAY IDEMPOTENCY -- idempotent-by-key, NOT "no replay path exists":
  // live keyed resume and the nudge re-drive never re-execute a completed
  // task (putWrites + skipDoneTasks), but crash-rehydration can. Checkpoint
  // durability defaults to 'async' (the checkpointer promise is tracked, not
  // awaited) and this tool's writes land in bearcode.db while the graph's
  // task writes land in checkpoints.db with no shared transaction -- so a
  // crash after the tool completed but before putWrites committed makes the
  // rehydrated+resumed graph RE-EXECUTE this task silently. A true replay
  // carries the identical title+body, so it derives the SAME artifact id
  // (the store returns the existing row: no second insert, no re-supersede,
  // no version bump) and the SAME event id (appendOrReplaceEvent replaces in
  // place; the renderer upserts by id).
  //
  // (2) COLLISION SAFETY across reused tool-call ids: provider tool-call ids
  // CAN REPEAT across iterations for non-Anthropic providers (graph.ts
  // callIdMap documents exactly this). Keyed on the id alone, a NEW plan
  // submitted under a reused tc.id would hit the store's existence check and
  // return the OLD row -- its policy reconstructed from the recorded status,
  // possibly "Plan approved. Begin implementation." for a plan the user never
  // saw -- and the new plan's body would never be recorded (in Ba2, a
  // plan_review-bypass trajectory). Folding sha256(JSON.stringify([title,
  // body])) into the key means different content diverges to a fresh row +
  // fresh event.
  //
  // Namespaced by conversationId because provider tool-call ids are only
  // unique per conversation at best (graph.ts callIdMap again). An id-less
  // provider falls back to random ids and accepts the residual
  // duplicate-on-crash window.
  const artifactIdFor = (toolCallId: string | undefined, title: string, body: string): string => {
    if (toolCallId === undefined) return randomUUID()
    // JSON.stringify([title, body]) rather than title+'\n'+body: the plain
    // concatenation is not injective (a newline in the title shifts content
    // into the body's slot), and two DIFFERENT plans must never share a key
    // under a reused tool-call id -- under request-review that would bypass
    // the plan_review pause (final-review I3).
    const contentHash = createHash('sha256')
      .update(JSON.stringify([title, body]))
      .digest('hex')
      .slice(0, 16)
    return `${conversationId}:${toolCallId}:${contentHash}:artifact`
  }
  // The event id is DERIVABLE from the artifact id (status re-emits need it
  // for rows created by OTHER calls, e.g. superseded priors, where only the
  // row id is at hand). For toolCallId-derived ids the concatenation is
  // byte-identical to the previous `${stem}:artifact-event`, so no history
  // migration; the random fallback's event id becomes derivable too.
  const artifactEventIdFor = (artifactId: string): string => `${artifactId}-event`

  // The artifact event is the one event these tools emit themselves (their
  // tool_call/tool_result rows ride graph.ts's generic drive-loop emission
  // like every other tool). appendOrReplaceEvent, never appendEvent: a
  // crash-rehydration replay re-emits this event under the SAME deterministic
  // id, and replacing in place keeps history at exactly one row
  // (db/index.ts appendOrReplaceEvent).
  const emitArtifactEvent = (artifact: Artifact, eventId: string): void => {
    const event: Event = {
      type: 'artifact',
      id: eventId,
      artifactId: artifact.id,
      artifactType: artifact.type,
      version: artifact.version,
      title: artifact.title,
      status: artifact.status,
      body: artifact.body
    }
    sink.emit(conversationId, event)
    appendOrReplaceEvent(conversationId, event)
  }

  // SECURITY (design 2026-07-04-ba-artifacts-design.md section 4): submit_plan
  // and submit_walkthrough write ONLY artifact DB rows. They have no workspace
  // or command capability and must never gain any; they are never gated by
  // permission rules/modes (there is nothing to gate); and the 'approved'
  // status submit_plan can mint under always-proceed is a workflow record
  // only -- plan approval NEVER pre-approves commands or edits (every Bb
  // permission gate still runs per call during implementation). The
  // plan_review pause below is a UX/workflow gate, not a security boundary --
  // approving a plan never pre-approves commands or edits.
  const submitPlanTool = tool(
    async ({ title, body }: { title: string; body: string }, config?: unknown): Promise<string> => {
      if (!title.trim() || !body.trim()) {
        return 'submit_plan needs a non-empty title and a non-empty markdown body. Nothing was recorded; call it again with both.'
      }
      const toolCallId = (config as { toolCallId?: string } | null | undefined)?.toolCallId
      // Hash the same values handed to the store, so a replayed call (which
      // re-derives them from the same tool args) folds to the same key (main's
      // 8d5a51f invariant, unchanged).
      const artifactId = artifactIdFor(toolCallId, title.trim(), body)
      // Design 5 gate, BEFORE the row exists: a stacked second submission must
      // record nothing (no orphan pending row that would supersede the plan
      // actually under review). Same-artifactId re-entry is a replay of the
      // paused submission (identical content hashes to the identical key) and
      // passes; a DIFFERENT submission -- even under a reused toolCallId --
      // derives a different key and is refused while the review is unresolved.
      // Scope (design 5, resolved): this error applies ONLY while a
      // plan_review interrupt is in flight; a new submission with no pending
      // interrupt supersedes still-pending priors instead (Ba1 behavior).
      if (!tryEnterPlanReview(conversationId, artifactId)) {
        return "A plan is already awaiting the user's review in this conversation. Wait for that review to be resolved before submitting another plan."
      }
      const { artifact, policy, superseded } = createPlanArtifact(
        conversationId,
        title.trim(),
        body,
        artifactId
      )
      // Chip un-stale (supersedes Ba1's point-in-time limitation): every prior
      // plan this submission superseded re-emits its artifact event under ITS
      // deterministic id, replacing the stale pending-review payload in place.
      for (const s of superseded) {
        emitArtifactEvent(s, artifactEventIdFor(s.id))
      }
      if (artifact.status === 'superseded') {
        // Replay edge: this submission's own row was superseded by a NEWER
        // submission in a later turn (the original pause was stopped). Never
        // re-pause on a dead plan.
        clearPlanReviewPending(conversationId)
        return 'This plan was superseded by a newer plan submission. Continue from the newest plan.'
      }
      emitArtifactEvent(artifact, artifactEventIdFor(artifact.id))
      if (policy === 'always-proceed') {
        // Docs: "immediately bypass the pause". Also the replay path for a row
        // already approved (Ba1's status->policy reconstruction): a crash
        // between the proceed-approve write and the checkpoint commit replays
        // into this branch and converges without re-interrupting.
        clearPlanReviewPending(conversationId)
        return 'Plan approved. Begin implementation.'
      }
      // THE PAUSE (design 3.5). Ordering is deliberate: the pending row and
      // its event are persisted ABOVE so the transcript card and the pane can
      // render the plan while the graph is suspended right here. interrupt()
      // parks this task; the resume value arrives via graph.ts's keyed resume
      // (buildResumeMap branches to PlanReviewResolution for plan items). On
      // any replay this whole function re-executes from the top and the
      // idempotent store + appendOrReplaceEvent + same-id gate re-entry
      // converge; the interrupt refires and either resolves from the resume
      // map or pauses again (crash-rehydration). Truthy-object contract: see
      // run_command's interrupt comment above.
      const raw = interrupt({
        kind: 'plan_review',
        artifactId,
        title: artifact.title,
        toolCallId
      })
      clearPlanReviewPending(conversationId)
      // Fail-safe resume handling: a well-formed proceed resolution is the
      // ONLY thing that reaches approval. Anything else -- a falsy resume, a
      // malformed object, or `proceed` that isn't literally `true` -- falls
      // through to the feedback branch below with a generic message. Never
      // widen this to a truthy-ish check: a bogus or corrupted resume value
      // must never mint an approval the user did not actually grant.
      const resolution = raw as
        { proceed?: unknown; comments?: string; feedback?: unknown } | null | undefined
      if (resolution != null && resolution.proceed === true) {
        const approved = approvePlanArtifact(artifact.id)
        emitArtifactEvent(
          approved ?? { ...artifact, status: 'approved', resolvedAt: Date.now() },
          artifactEventIdFor(artifact.id)
        )
        return (
          'Plan approved. Begin implementation.' +
          (resolution.comments
            ? `\n\nThe user attached comments to guide the implementation:\n\n${resolution.comments}`
            : '')
        )
      }
      // Feedback: the artifact STAYS pending-review (design 3.1) -- no status
      // write, no re-emit. The agent iterates and may submit again; the new
      // submission supersedes this row (and un-stales its chip, above). A
      // malformed or missing feedback string still falls here, never into
      // approval, with a generic message in its place.
      const feedback =
        resolution != null &&
        typeof resolution.feedback === 'string' &&
        resolution.feedback.length > 0
          ? resolution.feedback
          : 'No feedback was provided.'
      return `The user reviewed the plan and left feedback instead of proceeding:\n\n${feedback}`
    },
    {
      name: 'submit_plan',
      description:
        'Submit an implementation plan artifact (markdown body) for the user to review before you change any files. ' +
        'The call may pause until the user reviews the plan; the result tells you whether to proceed or contains feedback to address.',
      schema: artifactSchema
    }
  )

  const submitWalkthroughTool = tool(
    async ({ title, body }: { title: string; body: string }, config?: unknown): Promise<string> => {
      if (!title.trim() || !body.trim()) {
        return 'submit_walkthrough needs a non-empty title and a non-empty markdown body. Nothing was recorded; call it again with both.'
      }
      const toolCallId = (config as { toolCallId?: string } | null | undefined)?.toolCallId
      const artifactId = artifactIdFor(toolCallId, title.trim(), body)
      const artifact = createWalkthroughArtifact(conversationId, title.trim(), body, artifactId)
      emitArtifactEvent(artifact, artifactEventIdFor(artifact.id))
      return `Walkthrough v${artifact.version} recorded.`
    },
    {
      name: 'submit_walkthrough',
      description:
        'Submit a walkthrough artifact (markdown body): a concise summary of the changes you made, ' +
        'after completing implementation work.',
      schema: artifactSchema
    }
  )

  // Design 4.3: activate_rule is read-only by construction. It only ever
  // reads the (cached) .agents rule set and returns a string -- it must never
  // touch the approval machinery (no interrupt, no evaluateCommandForConversation)
  // and it never throws, even on a missing/errored/wrong-mode rule name.
  const activateRuleTool = tool(
    async ({ name }: { name: string }): Promise<string> => {
      const content = loadAgentsContent(projectPath)
      const modelRules = content.rules.filter((r) => r.activation === 'model' && !r.error)
      const exact = modelRules.find((r) => r.name === name)
      const found = exact ?? modelRules.find((r) => r.name.toLowerCase() === name.toLowerCase())
      if (found) {
        return `Rule ${found.name}:\n${found.body}`
      }
      const candidates = modelRules.map((r) => r.name).join(', ')
      return `Unknown rule: ${name}. Available rules: ${candidates}`
    },
    {
      name: 'activate_rule',
      description:
        'Load the full text of an available project rule by name. Use when a rule from the Available rules index is relevant to the current task.',
      schema: activateRuleSchema
    }
  )

  const docSchema = z.object({
    path: z.string().describe('Workspace-relative path for the new file, e.g. "report.docx".'),
    format: z.enum(['docx', 'xlsx', 'pdf']).describe('Document format to generate.'),
    content: z
      .string()
      .describe(
        'The document content as markdown-ish text: "# " / "## " become headings; ' +
          'for xlsx, tab-separated lines become columns.'
      )
  })
  const generateDocumentTool = tool(
    async ({
      path,
      format,
      content
    }: {
      path: string
      format: DocFormat
      content: string
    }): Promise<string> => {
      if (!projectPath) {
        return 'No folder is open. Open a folder first so I can create files there.'
      }
      // Gate stays in PROJECT space (approval cards + permission rules are
      // project-relative, matching the GatedDiffFsBackend contract): jail + the
      // rel used for the rules engine and the user-facing message come from the
      // project path.
      const projAbs = jailPath(projectPath, path)
      const rel = relForGate(projectPath, projAbs)
      const decision = evaluateEditForConversation(rel, conversationId, projectPath)
      const decline = docGenGateMessage(decision, resolveConversationMode(conversationId))
      if (decline) return decline
      let buffer: Buffer
      try {
        buffer = await generateDocument(format, content)
      } catch (err) {
        return `Failed to generate ${format}: ${err instanceof Error ? err.message : String(err)}`
      }
      const marker = `(binary: ${format}, ${buffer.length.toLocaleString()} bytes — preview coming in E9)`
      // F3: route the actual write into the matching worktree (loose files stay
      // at the project root) so a generated doc never lands in the real project
      // tree while write_file edits land in the worktree — the wrong-tree write
      // the multi-root backend exists to prevent.
      const abs = worktreeWritePath(projAbs, worktrees)
      recordBinaryCreation(diffGroupId, conversationId, abs, buffer, marker)
      return `Created ${format} file at ${rel} (${buffer.length.toLocaleString()} bytes).`
    },
    {
      name: 'generate_document',
      description:
        'Create a real docx, xlsx, or pdf file in the workspace from text content. Use this ' +
        'when asked to produce/convert a document (e.g. "make a PDF", "convert this to docx") ' +
        'instead of writing raw bytes with write_file. Respects the current permission mode.',
      schema: docSchema
    }
  )

  // ── F4 browser_* tools ────────────────────────────────────────────────────
  // A live embedded browser (WebContentsView driven by Playwright over CDP,
  // Task 4's browserManager) surfaced as flat tools on the main agent. The
  // 4-layer guard chain (design §L0–L3) runs entirely here:
  //   L0 enable   — every tool refuses unless Settings.browserEnabled === true.
  //   L1 consent  — the first navigate/mutation prompts once per conversation.
  //   L2 domain   — navigate consults the allow/blocklist (originDecision).
  //   L3 mode     — mutations (click/type/evaluate) respect the permission mode
  //                 exactly like run_command: plan blocks, ask prompts,
  //                 accept-edits/auto/bypass allow. Reads run completely free.
  // browserEnabled/browserAllowlist/browserBlocklist are AppSettings fields that
  // do not formally exist until B4; read them defensively (migrateSettings
  // spreads unknown keys through, so a manually-set settings.json value already
  // flows here). See the manager for the a11y-ref contract: browser_read('a11y')
  // returns an ariaSnapshot with `[ref=e<N>]` handles that click/type address.
  const browserEnabled = (): boolean =>
    (getSettings() as { browserEnabled?: boolean }).browserEnabled === true
  const browserPolicy = (): DomainPolicy => {
    const s = getSettings() as { browserAllowlist?: unknown; browserBlocklist?: unknown }
    return {
      allowlist: Array.isArray(s.browserAllowlist) ? (s.browserAllowlist as string[]) : [],
      blocklist: Array.isArray(s.browserBlocklist) ? (s.browserBlocklist as string[]) : []
    }
  }
  const browserToolCallId = (config: unknown): string | undefined =>
    (config as { toolCallId?: string } | null | undefined)?.toolCallId

  // The L1-consent-or-L3-prompt gate for a navigation/mutation. Returns a
  // refusal string to hand back to the model, or null to proceed. `decision`
  // is the L2/L3 outcome for the action; consent is FOLDED into the first
  // prompt (design §L1: "fold consent into the first navigate prompt") so a
  // conversation's first navigate/mutation always pauses once even in auto mode
  // — the deliberate session-consent boundary — while later actions only pause
  // when their own decision says 'prompt'. On any keyed-resume replay this
  // whole tool re-executes from the top, re-derives the same decision, and
  // interrupt() returns the recorded { approved } (run_command's contract).
  const gateBrowserAction = (
    decision: 'allow' | 'prompt' | 'block',
    blockedMessage: string,
    action: string,
    config: unknown
  ): string | null => {
    const toolCallId = browserToolCallId(config)
    // BEFORE the block/prompt/consent decision: on a keyed-resume replay a
    // recorded Denial must win even when the decision has since flipped to
    // 'allow' (mode→auto, session consent granted by an approved sibling, or
    // the origin added to the allowlist) and would otherwise skip interrupt()
    // and execute the action the user explicitly denied — the run_command
    // deniedReplayPins contract, applied to browser mutations/navigation.
    if (takeDeniedBrowserReplayPin(conversationId, toolCallId, action)) {
      return 'User denied this browser action.'
    }
    if (decision === 'block') return blockedMessage
    const needsConsent = !browserSessionConsent.has(conversationId)
    if (decision === 'prompt' || needsConsent) {
      const approval = interrupt({
        kind: 'browser',
        action,
        toolCallId
      }) as { approved?: boolean } | null | undefined
      if (!approval?.approved) return 'User denied this browser action.'
      browserSessionConsent.add(conversationId)
    }
    return null
  }

  const browserNavigateTool = tool(
    async ({ url }: { url: string }, config?: unknown): Promise<string> => {
      if (!browserEnabled()) return BROWSER_DISABLED_MESSAGE
      // L2 domain policy first: a blocklisted origin is refused before we ever
      // launch the browser or ask for consent (there is nothing to consent to).
      // navigate is read-class — the mode never blocks it (the guard's navigate
      // branch ignores mode), but BrowserActionInput requires the field.
      const decision = evaluateBrowserAction({
        kind: 'navigate',
        url,
        policy: browserPolicy(),
        mode: resolveConversationMode(conversationId)
      })
      const refusal = gateBrowserAction(
        decision,
        `Blocked: ${url} is not permitted by the browser domain policy (blocklist).`,
        browserActionLabel('browser_navigate', { url }),
        config
      )
      if (refusal) return refusal
      await browserManager.start(conversationId)
      const { url: landed, title } = await browserManager.navigate(url)
      return `Navigated to ${landed}${title ? ` — "${title}"` : ''}.`
    },
    {
      name: 'browser_navigate',
      description:
        'Open a URL in the live browser. May pause for approval if the site is not on the allowlist. ' +
        'After navigating, call browser_read (mode "a11y") to get the page structure with [ref=e<N>] handles before clicking or typing.',
      schema: z.object({
        url: z.string().describe('The absolute URL to open (include the scheme).')
      })
    }
  )

  const browserReadTool = tool(
    async ({ mode }: { mode?: 'text' | 'a11y' | 'html' }): Promise<string> => {
      if (!browserEnabled()) return BROWSER_DISABLED_MESSAGE
      await browserManager.start(conversationId)
      return browserManager.read(mode ?? 'a11y')
    },
    {
      name: 'browser_read',
      description:
        'Read the current page. mode "a11y" (default) returns an accessibility tree tagged with ' +
        '[ref=e<N>] handles — use those refs with browser_click/browser_type. mode "text" returns ' +
        'the visible text; mode "html" returns the raw HTML. Reading never requires approval.',
      schema: z.object({ mode: z.enum(['text', 'a11y', 'html']).optional() })
    }
  )

  const browserScreenshotTool = tool(
    async (_args: unknown, config?: unknown): Promise<string> => {
      if (!browserEnabled()) return BROWSER_DISABLED_MESSAGE
      await browserManager.start(conversationId)
      const dataUrl = await browserManager.screenshot()
      // Keep the base64 image OUT of the model's context. A full-page PNG data
      // URL is ~150K–1.5M chars (~100K+ tokens as text) and would (a) be sliced
      // mid-base64 by graph.ts's 50000-char tool_result budget into a BROKEN
      // <img>, and (b) flood/derail the very conversation driving the browser
      // on every subsequent turn. Instead we stash the data URL on the manager
      // keyed by the provider tool-call id; graph.ts splices it into the
      // PERSISTED tool_result output so the step card still renders the image,
      // while the model sees only this short placeholder — mirroring
      // run_command's bounded text budget. Id-less providers (no tool-call id to
      // key the stash by) fall back to inlining the data URL; the card still
      // renders and the residual flood is accepted for that rarer case.
      const toolCallId = browserToolCallId(config)
      if (toolCallId === undefined) return dataUrl
      browserManager.stashScreenshot(toolCallId, dataUrl)
      return `Screenshot captured (~${Math.round(dataUrl.length / 1024)} KB); rendered in the browser step for the user.`
    },
    {
      name: 'browser_screenshot',
      description:
        'Capture a PNG screenshot of the current page. The image is shown to the user inline in the ' +
        'browser step; you receive a short confirmation (not the raw image). Use it to show progress. ' +
        'Never requires approval.',
      schema: z.object({})
    }
  )

  const browserScrollTool = tool(
    async ({ direction }: { direction?: 'up' | 'down' }): Promise<string> => {
      if (!browserEnabled()) return BROWSER_DISABLED_MESSAGE
      await browserManager.start(conversationId)
      const dir = direction ?? 'down'
      await browserManager.scroll(dir)
      return `Scrolled ${dir}.`
    },
    {
      name: 'browser_scroll',
      description: 'Scroll the current page up or down (default down). Never requires approval.',
      schema: z.object({ direction: z.enum(['up', 'down']).optional() })
    }
  )

  const browserWaitTool = tool(
    async ({ state }: { state?: 'load' | 'networkidle' }): Promise<string> => {
      if (!browserEnabled()) return BROWSER_DISABLED_MESSAGE
      await browserManager.start(conversationId)
      const s = state ?? 'load'
      await browserManager.waitFor(s)
      return `Waited for ${s}.`
    },
    {
      name: 'browser_wait',
      description:
        'Wait for the page to reach a load state ("load" or "networkidle", default "load"). ' +
        'Never requires approval.',
      schema: z.object({ state: z.enum(['load', 'networkidle']).optional() })
    }
  )

  const browserClickTool = tool(
    async ({ ref }: { ref: string }, config?: unknown): Promise<string> => {
      if (!browserEnabled()) return BROWSER_DISABLED_MESSAGE
      const mode = resolveConversationMode(conversationId)
      const decision = evaluateBrowserAction({ kind: 'mutate', mode })
      const refusal = gateBrowserAction(
        decision,
        'Plan mode is read-only; browser clicks are blocked. Submit a plan and wait for approval first.',
        browserActionLabel('browser_click', { ref }),
        config
      )
      if (refusal) return refusal
      await browserManager.start(conversationId)
      await browserManager.click(ref)
      return `Clicked ${ref}.`
    },
    {
      name: 'browser_click',
      description:
        'Click an element by its a11y ref (an e<N> handle from browser_read mode "a11y"). ' +
        'Requires approval in ask mode; blocked in plan mode.',
      schema: z.object({
        ref: z.string().describe('An element ref, e.g. "e12", from browser_read.')
      })
    }
  )

  const browserTypeTool = tool(
    async (
      { ref, text, submit }: { ref: string; text: string; submit?: boolean },
      config?: unknown
    ): Promise<string> => {
      if (!browserEnabled()) return BROWSER_DISABLED_MESSAGE
      const mode = resolveConversationMode(conversationId)
      const decision = evaluateBrowserAction({ kind: 'mutate', mode })
      const refusal = gateBrowserAction(
        decision,
        'Plan mode is read-only; browser typing is blocked. Submit a plan and wait for approval first.',
        browserActionLabel('browser_type', { ref }),
        config
      )
      if (refusal) return refusal
      await browserManager.start(conversationId)
      await browserManager.type(ref, text, submit ?? false)
      return `Typed into ${ref}${submit ? ' and submitted' : ''}.`
    },
    {
      name: 'browser_type',
      description:
        'Type text into an element by its a11y ref (an e<N> handle from browser_read mode "a11y"). ' +
        'Set submit=true to press Enter afterward. Requires approval in ask mode; blocked in plan mode.',
      schema: z.object({
        ref: z.string().describe('An element ref, e.g. "e7", from browser_read.'),
        text: z.string().describe('The text to type.'),
        submit: z.boolean().optional().describe('Press Enter after typing.')
      })
    }
  )

  const browserEvaluateTool = tool(
    async ({ script }: { script: string }, config?: unknown): Promise<string> => {
      if (!browserEnabled()) return BROWSER_DISABLED_MESSAGE
      const mode = resolveConversationMode(conversationId)
      const decision = evaluateBrowserAction({ kind: 'mutate', mode })
      const refusal = gateBrowserAction(
        decision,
        'Plan mode is read-only; running JavaScript in the page is blocked. Submit a plan and wait for approval first.',
        browserActionLabel('browser_evaluate', {}),
        config
      )
      if (refusal) return refusal
      await browserManager.start(conversationId)
      return browserManager.evaluate(script)
    },
    {
      name: 'browser_evaluate',
      description:
        'Run a JavaScript expression in the current page and return its result. This is a mutation: ' +
        'requires approval in ask mode; blocked in plan mode.',
      schema: z.object({
        script: z.string().describe('A JavaScript expression to evaluate in the page.')
      })
    }
  )

  return [
    runCommandTool,
    submitPlanTool,
    submitWalkthroughTool,
    activateRuleTool,
    generateDocumentTool,
    browserNavigateTool,
    browserReadTool,
    browserScreenshotTool,
    browserScrollTool,
    browserWaitTool,
    browserClickTool,
    browserTypeTool,
    browserEvaluateTool
  ]
}
