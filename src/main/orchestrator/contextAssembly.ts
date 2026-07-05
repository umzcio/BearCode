// Turns the live .agents/ rule set into prompt text for one turn (design 3.2).
// Pure: no disk, no DB, no Electron -- callers gather the inputs (loaded
// rules, the conversation's pinned manual rules, D3's future @ mentions, and
// touchedFilesFor's query result) and this just orders and renders them.
// Rules with `error` set are malformed (design 11) and are skipped in every
// section below, never surfaced to the model.
import type { AgentsContent, Rule } from '../agentsDir/types'
import { matchesEditPath } from '../permissions/rules'

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
