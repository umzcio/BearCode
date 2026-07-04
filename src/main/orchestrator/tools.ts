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
import { realpathSync } from 'fs'
import { interrupt } from '@langchain/langgraph'
import { tool } from 'langchain'
import { z } from 'zod'
import { evaluateCommandForConversation } from '../permissions'

const commandSchema = z.object({
  command: z.string().describe('Shell command to run in the workspace folder.'),
  timeoutMs: z.number().int().min(1000).max(600000).optional().describe('Timeout, default 60s.')
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
// always wins over a re-evaluation.
//
// Pins are keyed by the provider tool-call id when the approval card knew it
// (the normal case: the interrupt payload carries it), falling back to a
// command-string multiset for cards without one (pre-toolCallId checkpoints,
// where the replayed call's config carries no id either). Take-once semantics:
// a consumed pin is deleted so a later, genuinely new call that happens to
// reuse a provider tool-call id (non-Anthropic providers can) or repeat the
// command string is never silently denied.
interface DeniedPinSet {
  byToolCallId: Set<string>
  byCommand: Map<string, number>
}
const deniedReplayPins = new Map<string, DeniedPinSet>()

export function pinDeniedReplays(
  conversationId: string,
  pins: ReadonlyArray<{ toolCallId?: string; command?: string }>
): void {
  if (pins.length === 0) return
  const set: DeniedPinSet = { byToolCallId: new Set(), byCommand: new Map() }
  for (const pin of pins) {
    if (pin.toolCallId !== undefined) {
      set.byToolCallId.add(pin.toolCallId)
    } else if (pin.command !== undefined) {
      set.byCommand.set(pin.command, (set.byCommand.get(pin.command) ?? 0) + 1)
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

// buildTools(projectPath, conversationId) returns the LangChain tool array passed to
// createDeepAgent's `tools` option (in addition to its always-on built-ins).
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Zod-inferred `tool()` return type is not writable by hand without narrowing away the actual generic
export function buildTools(projectPath: string, conversationId: string) {
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
  return [runCommandTool]
}
