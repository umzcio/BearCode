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
import { createPlanArtifact, createWalkthroughArtifact } from '../artifacts/store'
import { evaluateCommandForConversation } from '../permissions'
import type { RunSink } from '../sink'

const commandSchema = z.object({
  command: z.string().describe('Shell command to run in the workspace folder.'),
  timeoutMs: z.number().int().min(1000).max(600000).optional().describe('Timeout, default 60s.')
})

const artifactSchema = z.object({
  title: z.string().describe('A short, human-readable title for the artifact.'),
  body: z.string().describe('The full artifact content, as markdown.')
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

// buildTools(projectPath, conversationId, sink) returns the LangChain tool array passed to
// createDeepAgent's `tools` option (in addition to its always-on built-ins).
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Zod-inferred `tool()` return type is not writable by hand without narrowing away the actual generic
export function buildTools(projectPath: string, conversationId: string, sink: RunSink) {
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
        return 'This command was blocked by a permission rule.'
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
  // plan_review-bypass trajectory). Folding sha256(title + '\n' + body) into
  // the key means different content diverges to a fresh row + fresh event.
  //
  // Namespaced by conversationId because provider tool-call ids are only
  // unique per conversation at best (graph.ts callIdMap again). An id-less
  // provider falls back to random ids and accepts the residual
  // duplicate-on-crash window.
  const artifactIdsFor = (
    toolCallId: string | undefined,
    title: string,
    body: string
  ): { artifactId: string; eventId: string } => {
    if (toolCallId === undefined) return { artifactId: randomUUID(), eventId: randomUUID() }
    const contentHash = createHash('sha256')
      .update(title + '\n' + body)
      .digest('hex')
      .slice(0, 16)
    const stem = `${conversationId}:${toolCallId}:${contentHash}`
    return { artifactId: `${stem}:artifact`, eventId: `${stem}:artifact-event` }
  }

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
  // permission gate still runs per call during implementation).
  const submitPlanTool = tool(
    async ({ title, body }: { title: string; body: string }, config?: unknown): Promise<string> => {
      if (!title.trim() || !body.trim()) {
        return 'submit_plan needs a non-empty title and a non-empty markdown body. Nothing was recorded; call it again with both.'
      }
      const toolCallId = (config as { toolCallId?: string } | null | undefined)?.toolCallId
      // Hash the same values handed to the store, so a replayed call (which
      // re-derives them from the same tool args) folds to the same key.
      const { artifactId, eventId } = artifactIdsFor(toolCallId, title.trim(), body)
      const { artifact, policy } = createPlanArtifact(
        conversationId,
        title.trim(),
        body,
        artifactId
      )
      emitArtifactEvent(artifact, eventId)
      if (policy === 'always-proceed') {
        // Docs: "immediately bypass the pause".
        return 'Plan approved. Begin implementation.'
      }
      // Ba1: the request-review pause (design 3.5, kind 'plan_review') arrives
      // with Ba2. Until then the tool still returns immediately, but the
      // artifact is recorded pending-review and the model is told to hold --
      // the agent pauses its own narrative; no interrupt machinery here.
      return (
        `Plan v${artifact.version} recorded. It is awaiting the user's review in the artifacts pane. ` +
        "Do not begin implementation; wait for the user's decision or feedback before making any changes."
      )
    },
    {
      name: 'submit_plan',
      description:
        'Submit an implementation plan artifact (markdown body) for the user to review before you change any files. ' +
        'The result tells you whether you may proceed.',
      schema: artifactSchema
    }
  )

  const submitWalkthroughTool = tool(
    async ({ title, body }: { title: string; body: string }, config?: unknown): Promise<string> => {
      if (!title.trim() || !body.trim()) {
        return 'submit_walkthrough needs a non-empty title and a non-empty markdown body. Nothing was recorded; call it again with both.'
      }
      const toolCallId = (config as { toolCallId?: string } | null | undefined)?.toolCallId
      const { artifactId, eventId } = artifactIdsFor(toolCallId, title.trim(), body)
      const artifact = createWalkthroughArtifact(conversationId, title.trim(), body, artifactId)
      emitArtifactEvent(artifact, eventId)
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

  return [runCommandTool, submitPlanTool, submitWalkthroughTool]
}
