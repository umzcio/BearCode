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
import { realpathSync } from 'fs'
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
import { jailPath, relForGate } from './fsBackend'
import { generateDocument, type DocFormat } from '../docgen/generate'
import { docGenGateMessage } from '../docgen/gate'
import { recordBinaryCreation } from '../diffs'

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
}
const deniedReplayPins = new Map<string, DeniedPinSet>()

export function pinDeniedReplays(
  conversationId: string,
  pins: ReadonlyArray<{ toolCallId?: string; command?: string; editPath?: string }>
): void {
  if (pins.length === 0) return
  const set: DeniedPinSet = {
    byToolCallId: new Set(),
    byCommand: new Map(),
    byEditPath: new Map()
  }
  for (const pin of pins) {
    if (pin.toolCallId !== undefined) {
      set.byToolCallId.add(pin.toolCallId)
    } else if (pin.command !== undefined) {
      set.byCommand.set(pin.command, (set.byCommand.get(pin.command) ?? 0) + 1)
    } else if (pin.editPath !== undefined) {
      set.byEditPath.set(pin.editPath, (set.byEditPath.get(pin.editPath) ?? 0) + 1)
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
  diffGroupId: string
) {
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
      const cwd = realpathSync(projectPath)
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
      const abs = jailPath(projectPath, path)
      const rel = relForGate(projectPath, abs)
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

  return [
    runCommandTool,
    submitPlanTool,
    submitWalkthroughTool,
    activateRuleTool,
    generateDocumentTool
  ]
}
