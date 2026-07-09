// The slash-command registry and workflow recursion/cap resolution (design
// 5.1-5.4/6.2, D2 Task 2). Pure: no disk, no DB, no Electron, no model calls
// -- callers (Task 3's buildAgentAndContext, the commands:list IPC handler)
// supply the loaded AgentsContent and this module only orders, greys, and
// resolves it into prompt-ready data.
//
// SECURITY (design 10, Global Constraints): workflow and rule content is
// PROMPT TEXT, never executed as code. resolveWorkflowSteps is a NAME lookup
// into already-loaded content -- never a path join from renderer input, no
// eval/exec/spawn anywhere near this file. A workflow-driven turn changes
// NOTHING about gating; this module imports nothing from
// src/main/permissions/.
import type { Workflow, AgentsContent } from '../agentsDir/types'
import { COMMAND_NAME_PATTERN, type CommandEntry } from '../../shared/types'

// Fixed menu order, section 6.2 copy verbatim (no em dashes). `resume` is a
// pure UI action (Task 4/5: opens the conversation picker, never reaches the
// send path); `goal`/`grill-me`/`compact` are the sendable built-ins (Task 3's
// run:start boundary enforces this); the remaining four are visible but
// coming-soon per the design's out-of-scope list.
export const BUILTIN_COMMANDS: CommandEntry[] = [
  {
    name: 'goal',
    description: 'Run until the specified goal is completely finished.',
    kind: 'builtin',
    status: 'live'
  },
  {
    name: 'grill-me',
    description: 'Interview me to align on a plan.',
    kind: 'builtin',
    status: 'live'
  },
  {
    name: 'compact',
    description: 'Summarize older messages to free up the context window.',
    kind: 'builtin',
    status: 'live'
  },
  {
    name: 'resume',
    description: 'Resume a previous conversation.',
    kind: 'builtin',
    status: 'live'
  },
  {
    name: 'browser',
    description: 'Delegate the task to the browser subagent in a live browser.',
    kind: 'builtin',
    status: 'live'
  },
  {
    name: 'teamwork-preview',
    description: 'Preview: run a team of agents on one task together.',
    kind: 'builtin',
    status: 'coming-soon'
  },
  {
    name: 'learn',
    description: 'Teach the agent a reusable skill from this session.',
    kind: 'builtin',
    status: 'coming-soon'
  }
]

const BUILTIN_NAMES = new Set(BUILTIN_COMMANDS.map((c) => c.name))

// The exact error text used for BOTH the menu entry (listCommands) and a
// resolveWorkflowSteps refusal (design 5.1: "a workflow with error set
// (parse or collision) refuses with that error" -- one string, not two
// copies that could drift).
function collisionError(name: string): string | undefined {
  return BUILTIN_NAMES.has(name) ? `name collides with the built-in /${name}` : undefined
}

// Built-ins first (fixed order), then non-erroring workflow entries
// alphabetically; a colliding or parse-broken workflow keeps its alphabetical
// place but comes back greyed (status 'coming-soon') with its error set
// (design 5.1/11) -- the menu shows it, send refuses it.
export function listCommands(content: AgentsContent): CommandEntry[] {
  const sorted = [...content.workflows].sort((a, b) => a.name.localeCompare(b.name))
  const workflowEntries: CommandEntry[] = sorted.map((wf): CommandEntry => {
    const error = collisionError(wf.name) ?? wf.error
    return {
      name: wf.name,
      description: wf.description,
      kind: 'workflow',
      status: error ? 'coming-soon' : 'live',
      source: wf.source,
      ...(error ? { error } : {})
    }
  })
  return [...BUILTIN_COMMANDS, ...workflowEntries]
}

// Work bounds (design 5.3, review finding), mirroring the resolveRuleRefs
// idiom in agentsDir/index.ts:
// - `chain` (per recursion PATH, a Set of workflow names on the current
//   chain): a name reappearing in its own chain is a cycle, refused with an
//   error naming it -- never inlined, never recursed into again.
// - `inclusions` (a single counter GLOBAL to one top-level resolve call):
//   every workflow expansion, including repeats reached via different
//   branches (a diamond A -> {B, C} -> D expands D twice), counts once.
//   Bounded by MAX_WORKFLOW_INCLUSIONS so a wide or deep expansion tree does
//   bounded work instead of exponential blowup; refused past the ceiling.
// - an incremental character counter tracking the RESOLVED steps'
//   `join('\n')` length exactly, checked after every non-reference step is
//   appended: the moment it exceeds the cap the resolution bails immediately
//   with an error, so a pathological expansion never first materializes an
//   unbounded string (review finding).
export const MAX_WORKFLOW_INCLUSIONS = 64
const WORKFLOW_CHAR_CAP = 12_000

// A step line is a workflow reference (design 5.3: "as a line or list item")
// only when its TRIMMED text is exactly `/other-name` -- nothing else on the
// line, so prose that merely mentions a slash command is never mistaken for
// a reference. Derived from the shared COMMAND_NAME_PATTERN (not a hand-
// rolled duplicate) so the name grammar can never drift between this and the
// parse-time/wire-time checks.
const STEP_REF = new RegExp(`^/(${COMMAND_NAME_PATTERN.source.slice(1, -1)})$`)

export type WorkflowResolution = { ok: true; steps: string[] } | { ok: false; error: string }

export function resolveWorkflowSteps(name: string, workflows: Workflow[]): WorkflowResolution {
  const byName = new Map(workflows.map((w) => [w.name, w]))
  let inclusions = 0
  let totalChars = 0
  let stepCount = 0

  function resolveOne(n: string, chain: Set<string>): string[] | { error: string } {
    const wf = byName.get(n)
    if (!wf) return { error: `Workflow /${n} does not exist` }

    const collision = collisionError(n)
    if (collision) return { error: collision }
    if (wf.error) return { error: wf.error }

    inclusions += 1
    if (inclusions > MAX_WORKFLOW_INCLUSIONS) {
      return {
        error: `Workflow /${name} resolves past the workflow inclusion limit of ${MAX_WORKFLOW_INCLUSIONS}`
      }
    }

    const nextChain = new Set(chain)
    nextChain.add(n)

    const resolved: string[] = []
    for (const step of wf.steps) {
      const trimmed = step.trim()
      const ref = STEP_REF.exec(trimmed)

      if (ref) {
        const refName = ref[1]
        if (!byName.has(refName)) {
          return { error: `Workflow /${n} references /${refName}, which does not exist` }
        }
        if (refName === n || chain.has(refName)) {
          return {
            error: `Workflow /${n} references /${refName}, which creates a reference cycle`
          }
        }
        const sub = resolveOne(refName, nextChain)
        if (!Array.isArray(sub)) return sub
        resolved.push(...sub)
        continue
      }

      totalChars += stepCount === 0 ? step.length : step.length + 1
      stepCount += 1
      if (totalChars > WORKFLOW_CHAR_CAP) {
        return { error: `Workflow /${name} resolves past the 12,000 character limit` }
      }
      resolved.push(step)
    }
    return resolved
  }

  const result = resolveOne(name, new Set())
  if (!Array.isArray(result)) return { ok: false, error: result.error }
  return { ok: true, steps: result }
}
