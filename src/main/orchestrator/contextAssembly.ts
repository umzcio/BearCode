// Turns the live .agents/ rule set into prompt text for one turn (design 3.2).
// Pure: no disk, no DB, no Electron -- callers gather the inputs (loaded
// rules, the conversation's pinned manual rules, D3's future @ mentions, and
// touchedFilesFor's query result) and this just orders and renders them.
// Rules with `error` set are malformed (design 11) and are skipped in every
// section below, never surfaced to the model.
import type { AgentsContent, Rule, Workflow } from '../agentsDir/types'
import { matchesEditPath } from '../permissions/rules'
import { resolveWorkflowSteps } from './commands'
import type { CommandRef, MentionRef } from '../../shared/types'

export interface RuleAssemblyInput {
  content: AgentsContent
  pinnedManualRules: string[] // conversation's active_rules (Task 5)
  mentionPaths: string[] // [] until D3
  touchedFiles: string[] // workspace-relative, from db query
}

export interface RuleAssembly {
  systemAdditions: string[] // ordered per design 3.2 (1,2,3,4)
  activatedGlobRules: string[] // names, for logging
}

function renderRuleBlock(rule: Rule): string[] {
  return ['', `### ${rule.name} (${rule.source})`, rule.body]
}

// graph.ts only registers the activate_rule tool (buildTools) when a
// project is open (a backend/backendFactory exists); a no-project turn never
// gets that tool wired in. Global rules (~/.bearcode/agents/rules) still
// load with no project open, so a 'model' activation rule can reach
// assembleRuleAdditions there too -- without this filter the prompt would
// advertise "Call the activate_rule tool" for a tool that isn't registered.
// Callers without a project must filter model rules out of the content
// before assembling, so section 4 (the "## Available rules" index) is never
// rendered.
export function withoutModelRules(content: AgentsContent): AgentsContent {
  return { ...content, rules: content.rules.filter((r) => r.activation !== 'model') }
}

export function assembleRuleAdditions(input: RuleAssemblyInput): RuleAssembly {
  const rules = input.content.rules.filter((r) => !r.error)
  const additions: string[] = []
  const activatedGlobRules: string[] = []

  // 1. Always On rules under "## Project rules".
  const alwaysRules = rules.filter((r) => r.activation === 'always')
  if (alwaysRules.length > 0) {
    additions.push('', '## Project rules')
    for (const rule of alwaysRules) additions.push(...renderRuleBlock(rule))
  }

  // 2. Pinned manual rules, then 3. glob-activated rules (a glob matches ANY
  // mentionPath or touchedFile), both under "## Activated rules".
  const pinned = new Set(input.pinnedManualRules)
  const manualActivated = rules.filter((r) => r.activation === 'manual' && pinned.has(r.name))

  const candidatePaths = [...input.mentionPaths, ...input.touchedFiles]
  const globActivated = rules.filter(
    (r) =>
      r.activation === 'glob' &&
      r.globs.some((glob) => candidatePaths.some((path) => matchesEditPath(glob, path)))
  )
  for (const rule of globActivated) activatedGlobRules.push(rule.name)

  const activatedRules = [...manualActivated, ...globActivated]
  if (activatedRules.length > 0) {
    additions.push('', '## Activated rules')
    for (const rule of activatedRules) additions.push(...renderRuleBlock(rule))
  }

  // 4. When any model-decision rules exist, an index the model can browse via
  // the activate_rule tool (Task 4).
  const modelRules = rules.filter((r) => r.activation === 'model')
  if (modelRules.length > 0) {
    additions.push('', '## Available rules')
    for (const rule of modelRules) additions.push(`- ${rule.name}: ${rule.description}`)
    additions.push(
      'Call the activate_rule tool with a rule name to load its full text when relevant.'
    )
  }

  return { systemAdditions: additions, activatedGlobRules }
}

// Turns a chosen slash command into the turn's system-prompt additions
// (design 3.2 items 5/6, 5.2/6.2, D2 Task 2). Pure and separate from
// assembleRuleAdditions above on purpose (Task 3's caller-side note): a
// broken .agents dir degrades the RULE additions and the turn still runs; a
// broken COMMAND refuses the turn outright. Those are different policies and
// must never share a try/catch.
export interface CommandAdditions {
  systemAdditions: string[]
  error?: string
}

// EXECUTION-MODE PRECEDENCE (Global Constraints, review finding): every
// command addition block ends with this line so a workflow's write_todos-
// first frame, or /goal's never-wait modifier, wins over the pinned
// execution mode's competing instructions (Ba3's default PLANNING mode
// instructs submit_plan-first / wait-for-review) for this turn only.
const PRECEDENCE_LINES = [
  '',
  'For this turn, these command instructions take precedence over the execution mode',
  'instructions above wherever the two conflict.'
]

export function assembleCommandAdditions(
  command: CommandRef | null,
  workflows: Workflow[]
): CommandAdditions {
  if (!command) return { systemAdditions: [] }

  if (command.kind === 'builtin') {
    if (command.name === 'goal') {
      return {
        systemAdditions: [
          '',
          "Turn modifier: /goal. Run until the user's stated goal is completely finished.",
          'Do not stop to ask intermediate questions or wait for confirmation; make reasonable',
          'decisions yourself and keep working until the goal is fully done.',
          ...PRECEDENCE_LINES
        ]
      }
    }
    if (command.name === 'grill-me') {
      return {
        systemAdditions: [
          '',
          'Turn modifier: /grill-me. Before implementing anything, interview the user to align',
          'on a plan. Ask focused clarifying questions about scope, constraints, and intent,',
          'then wait for the answers. Do not create or edit any files and do not run any',
          'state-changing commands in this turn.',
          ...PRECEDENCE_LINES
        ]
      }
    }
    // /compact contributes no system prompt text: the summarizer is forced to
    // fire for this turn main-side (markForceCompact in runGraph) and the turn's
    // directive rides as the user message (graph.ts modelText). This branch
    // exists so a sent /compact is NOT treated as an unknown builtin below and
    // refused — it flows through the same assembleCommandAdditions path as the
    // other built-ins, just with an empty contribution.
    if (command.name === 'compact') {
      return { systemAdditions: [] }
    }
    return { systemAdditions: [], error: `Unknown command: /${command.name}` }
  }

  const resolved = resolveWorkflowSteps(command.name, workflows)
  if (!resolved.ok) return { systemAdditions: [], error: resolved.error }

  const stepLines = resolved.steps.map((step, i) => `${i + 1}. ${step}`)
  return {
    systemAdditions: [
      '',
      `You are executing the workflow "/${command.name}". Its steps, in order:`,
      ...stepLines,
      '',
      'Your FIRST tool call this turn MUST be write_todos, recording exactly these steps',
      'as your todo list, one todo per step, in this order. Do not call any other tool',
      'before write_todos.',
      'Then process each step sequentially and completely; do not skip or reorder steps.',
      'Mark each todo completed as soon as you finish it and keep the todo list current',
      'with write_todos as you work.',
      ...PRECEDENCE_LINES
    ]
  }
}

// ---- @ mentions (D3) ----

// The final assistant answer + title of a referenced conversation, resolved by
// the caller (buildAgentAndContext) from the db. Kept as an injected dep so
// this module stays pure/testable (no db import).
export interface ConversationSummary {
  title: string
  finalAnswer: string | null
}

export interface UserMentionsDeps {
  conversationSummary(conversationId: string): ConversationSummary | null
}

// File-kind mention paths (path preferred, name fallback), for BOTH the
// Referenced-files block below and the glob-on-mention hook
// (assembleRuleAdditions.mentionPaths, graph.ts). Pure.
export function mentionedFilePaths(mentions: MentionRef[]): string[] {
  return mentions
    .filter((m) => m.kind === 'file')
    .map((m) => m.path ?? m.name)
    .filter((p): p is string => !!p)
}

// Rule-kind mention names, for pinning into active_rules (graph.ts). Pure.
export function mentionedRuleNames(mentions: MentionRef[]): string[] {
  return mentions.filter((m) => m.kind === 'rule').map((m) => m.name)
}

// Union existing pinned rule names with freshly mentioned ones, de-duplicated,
// order preserved (existing first). Pure.
export function mergeActiveRules(existing: string[], mentioned: string[]): string[] {
  return Array.from(new Set([...existing, ...mentioned]))
}

// Turns @ mentions into this turn's system-prompt additions (D3 design 7):
// a "Referenced files" block that names the paths and instructs the agent to
// read what it needs (never inlines content), and one block per referenced
// conversation with its title + final assistant answer. Pure: the caller
// supplies conversation lookups via deps. @rule mentions produce NO text here
// — they pin into active_rules and flow through assembleRuleAdditions instead.
export function assembleUserMentions(
  mentions: MentionRef[],
  deps: UserMentionsDeps
): { systemAdditions: string[] } {
  const additions: string[] = []

  const filePaths = mentionedFilePaths(mentions)
  if (filePaths.length > 0) {
    additions.push(
      '',
      '## Referenced files',
      'The user referenced these workspace files for this turn. Read the ones you need with',
      'read_file; do not assume their contents.'
    )
    for (const p of filePaths) additions.push(`- ${p}`)
  }

  for (const m of mentions) {
    if (m.kind !== 'conversation' || !m.conversationId) continue
    const summary = deps.conversationSummary(m.conversationId)
    if (!summary) continue
    additions.push(
      '',
      `## Referenced conversation: ${summary.title}`,
      'The user referenced a past conversation. Its final answer was:',
      summary.finalAnswer ?? '(no final answer was recorded in that conversation)'
    )
  }

  return { systemAdditions: additions }
}
