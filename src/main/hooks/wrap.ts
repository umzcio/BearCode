// wrapToolsWithHooks: the ONE generic wrapper (design 2026-07-11-hooks-arc-
// design.md §5.2) that runs PreToolUse before every tool call and
// PostToolUse after. Applied ONCE, to the whole composed tools array, right
// before createDeepAgent -- not a per-tool edit; the matcher inside each
// hook record decides which tools actually fire.
//
// Security-critical: a hook can only TIGHTEN the outcome, never bypass the
// permission system. `deny` short-circuits (the reason is returned as the
// tool result; the original tool never runs). `ask` forces the existing
// interrupt() approval card even when the base permission gate would have
// auto-allowed. `allow` -- or ANY failure while consulting the hooks layer
// itself -- falls through to the ORIGINAL tool's own body, which still runs
// its full, independent permission evaluation exactly as if this wrapper
// didn't exist; a hook is an additional gate layered in FRONT of that, never
// a replacement for it. That is also why the original tool's invocation
// below is awaited with NO try/catch: an interrupt() call inside the
// wrapped tool itself (run_command's own approval prompt, an MCP/
// integration/browser prompt, ...) throws a LangGraph GraphInterrupt that
// must propagate untouched -- catching it here to report a PostToolUse
// failure would swallow the pause and break the tool's own approval flow
// (mirrors fsBackend.ts's gate, verified there by a dedicated "lets a
// GraphInterrupt ... PROPAGATE, never swallowed" test).
import { interrupt } from '@langchain/langgraph'
import { tool } from 'langchain'
import { runPostToolUse, runPreToolUse, type HookCtx } from './runner'

interface WrappableTool {
  name: string
  description?: string
  schema?: unknown
  invoke: (input: unknown, config?: unknown) => Promise<unknown>
}

function isWrappable(t: unknown): t is WrappableTool {
  return (
    !!t &&
    typeof t === 'object' &&
    typeof (t as WrappableTool).name === 'string' &&
    typeof (t as WrappableTool).invoke === 'function'
  )
}

export function wrapToolsWithHooks(tools: unknown[], ctx: HookCtx): unknown[] {
  return tools.map((t) => {
    if (!isWrappable(t)) return t
    const original = t
    return tool(
      async (input: unknown, config?: unknown): Promise<unknown> => {
        const toolCallId = (config as { toolCallId?: string } | null | undefined)?.toolCallId
        // Outer safety net: runner.ts already fails open for a single hook's
        // own spawn/timeout/parse failure, but if consulting the hooks layer
        // itself throws for any other reason, that must ALSO fail open
        // (never wedge or block the agent) -- the base permission gate the
        // original tool runs below is what stays authoritative either way.
        let decision: { decision: 'allow' | 'deny' | 'ask'; reason?: string }
        try {
          decision = await runPreToolUse(original.name, input, ctx)
        } catch {
          decision = { decision: 'allow' }
        }
        if (decision.decision === 'deny') {
          return decision.reason ?? 'Blocked by a hook.'
        }
        if (decision.decision === 'ask') {
          const approval = interrupt({
            kind: 'hook_ask',
            tool: original.name,
            input,
            reason: decision.reason,
            toolCallId
          }) as { approved?: boolean } | null | undefined
          if (!approval?.approved) return 'User denied this action.'
        }
        // allow (or an approved ask): run the ORIGINAL tool. See the file
        // header for why nothing wraps this call in a try/catch.
        const result = await original.invoke(input, config)
        // PostToolUse is observe-only and fire-and-forget (design §4): never
        // await it into the tool's return path, and never let it throw back
        // into the agent loop.
        void runPostToolUse(original.name, input, true, result, ctx).catch(() => {})
        return result
      },
      {
        name: original.name,
        description: original.description ?? '',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        schema: original.schema as any
      }
    )
  })
}
