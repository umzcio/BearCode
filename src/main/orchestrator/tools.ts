// The orchestrator's one custom tool: run_command. Everything else (reading,
// writing, editing, listing, searching) is a Deep Agents built-in tool routed
// through the custom filesystem backend (fsBackend.ts). run_command has no
// built-in equivalent, so it is added explicitly and gated behind an
// approval interrupt (spec 6.2 parity, risk 4): when
// getSettings().autoApproveCommands is false, `interrupt()` pauses the graph
// (verified pattern: planning/replatform-api-notes.md section (d2),
// node_modules/@langchain/langgraph/dist/interrupt.d.ts) and the resolved
// `resume` value (true/false) is what the promise returned by `interrupt()`
// evaluates to once the graph is re-invoked with `new Command({ resume })`.
//
// The shell-execution body below is the jailed run_command implementation:
// same shell, timeout/kill, and output-truncation behavior the engine has
// always used.
import { spawn } from 'child_process'
import { realpathSync } from 'fs'
import { interrupt } from '@langchain/langgraph'
import { tool } from 'langchain'
import { z } from 'zod'
import { getSettings } from '../settings'

const commandSchema = z.object({
  command: z.string().describe('Shell command to run in the workspace folder.'),
  timeoutMs: z.number().int().min(1000).max(600000).optional().describe('Timeout, default 60s.')
})

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

// buildTools(projectPath) returns the LangChain tool array passed to
// createDeepAgent's `tools` option (in addition to its always-on built-ins).
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Zod-inferred `tool()` return type is not writable by hand without narrowing away the actual generic
export function buildTools(projectPath: string) {
  const runCommandTool = tool(
    async ({ command, timeoutMs }: { command: string; timeoutMs?: number }): Promise<string> => {
      const needsApproval = !getSettings().autoApproveCommands
      if (needsApproval) {
        // Resume value must be wrapped in a truthy object, not a bare
        // boolean: LangGraph's mapCommand (pregel/io.js) guards resume
        // handling with `if (cmd.resume)`, so `Command({ resume: false })`
        // is indistinguishable from no resume at all and throws
        // EmptyInputError("Received empty Command input") -- verified live
        // (node_modules/@langchain/langgraph/dist/pregel/io.js).
        const decision = interrupt({ kind: 'run_command', command }) as { approved: boolean }
        if (!decision.approved) return 'User denied this command.'
      }
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
