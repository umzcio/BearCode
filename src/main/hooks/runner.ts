// Hook runner: spawns each matching hook's command with a JSON payload on
// stdin, a hard timeout, and collects a JSON decision off stdout (design
// 2026-07-11-hooks-arc-design.md §4). Security-critical semantics: hooks can
// only TIGHTEN a permission decision, never bypass it. Any hook that errors,
// times out, or returns malformed/unparseable output is treated as `allow`
// for that hook (fail OPEN) -- safe because the caller (wrap.ts) still runs
// the tool's normal permission evaluation afterward. PostToolUse is
// observe-only and never throws, regardless of what a hook does.
import { execFile } from 'child_process'
import { homedir } from 'os'
import type { HookDecision, HookEvent, HookRecord } from '../../shared/types'
import { buildSandboxPolicy } from '../orchestrator/sandbox/policy'
import { seatbeltRunner } from '../orchestrator/sandbox/runner'
import { scrubEnv } from '../orchestrator/sandbox/scrubEnv'
import { loadHooks } from './loader'

export interface HookCtx {
  projectPath: string | null
  conversationId: string
  trusted: boolean
  sandbox?: boolean
}

function matcherTests(matcher: string, toolName: string): boolean {
  if (matcher === '' || matcher === '*') return true
  try {
    return new RegExp(matcher).test(toolName)
  } catch {
    // Invalid regex authored into hooks.json -- never let it match.
    return false
  }
}

function matchingHooks(event: HookEvent, toolName: string, ctx: HookCtx): HookRecord[] {
  return loadHooks(ctx.projectPath, { trusted: ctx.trusted }).filter(
    (rec) => rec.consented && rec.event === event && matcherTests(rec.matcher, toolName)
  )
}

interface HookPayload {
  event: HookEvent
  conversationId: string
  workspacePaths: string[]
  toolName: string
  toolInput: unknown
  ok?: boolean
  result?: unknown
}

// Runs one hook command to completion (or its timeout). Resolves with the
// raw stdout string on a clean exit, or null on ANY failure (spawn error,
// non-zero/timeout kill, stdin write failure) -- callers treat null as
// "this hook had nothing valid to say" and fail open.
function runOne(rec: HookRecord, payload: HookPayload, ctx: HookCtx): Promise<string | null> {
  const cwd = ctx.projectPath ?? homedir()
  let file: string
  let args: string[]
  let env: NodeJS.ProcessEnv
  if (ctx.sandbox && seatbeltRunner.available()) {
    const plan = seatbeltRunner.wrap(rec.command, cwd, buildSandboxPolicy(cwd, false))
    file = plan.file
    args = plan.args
    env = plan.env
  } else {
    file = 'sh'
    args = ['-c', rec.command]
    env = scrubEnv(process.env)
  }

  return new Promise((resolve) => {
    let settled = false
    const child = execFile(
      file,
      args,
      { cwd, env, timeout: rec.timeout * 1000, killSignal: 'SIGKILL' },
      (err, stdout) => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        resolve(err ? null : stdout.toString())
      }
    )
    try {
      child.stdin?.write(JSON.stringify(payload))
      child.stdin?.end()
    } catch {
      // A dead/closed stdin still lets the exit/error callback resolve us.
    }
    // Belt-and-suspenders: execFile's `timeout` sends killSignal (SIGKILL,
    // above) which cannot be trapped/ignored -- but if a hook somehow still
    // fails to exit (e.g. an unkillable zombie), this backstop guarantees we
    // still fail open instead of wedging the caller's tool call forever.
    const deadline = setTimeout(
      () => {
        if (settled) return
        settled = true
        try {
          child.kill('SIGKILL')
        } catch {
          // Already dead -- nothing to do.
        }
        resolve(null)
      },
      (rec.timeout + 5) * 1000
    )
    deadline.unref?.()
  })
}

function parseDecision(raw: string | null): HookDecision | null {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  if (obj.decision !== 'allow' && obj.decision !== 'deny' && obj.decision !== 'ask') return null
  return {
    decision: obj.decision,
    reason: typeof obj.reason === 'string' ? obj.reason : undefined
  }
}

export async function runPreToolUse(
  toolName: string,
  toolInput: unknown,
  ctx: HookCtx
): Promise<HookDecision> {
  const hooks = matchingHooks('PreToolUse', toolName, ctx)
  if (hooks.length === 0) return { decision: 'allow' }

  const payload: HookPayload = {
    event: 'PreToolUse',
    conversationId: ctx.conversationId,
    workspacePaths: ctx.projectPath ? [ctx.projectPath] : [],
    toolName,
    toolInput
  }
  const decisions = await Promise.all(
    hooks.map((rec) => runOne(rec, payload, ctx).then(parseDecision))
  )

  const deny = decisions.find((d) => d?.decision === 'deny')
  if (deny) return deny
  const ask = decisions.find((d) => d?.decision === 'ask')
  if (ask) return ask
  return { decision: 'allow' }
}

export async function runPostToolUse(
  toolName: string,
  toolInput: unknown,
  ok: boolean,
  result: unknown,
  ctx: HookCtx
): Promise<void> {
  const hooks = matchingHooks('PostToolUse', toolName, ctx)
  if (hooks.length === 0) return

  const payload: HookPayload = {
    event: 'PostToolUse',
    conversationId: ctx.conversationId,
    workspacePaths: ctx.projectPath ? [ctx.projectPath] : [],
    toolName,
    toolInput,
    ok,
    result
  }
  // Fire-and-forget: runOne never rejects (all failure paths resolve null),
  // so this can never throw regardless of what the hooks do.
  await Promise.all(hooks.map((rec) => runOne(rec, payload, ctx)))
}
