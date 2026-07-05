// Rule types for the .agents/ rules engine (design 3.1/3.2). A Rule is the
// parsed shape of one .agents/rules/*.md (or ~/.bearcode/agents/rules/*.md)
// file; assembly (contextAssembly.ts, added in a later task) turns the live
// set into prompt text per activation mode. Kept dependency-free and pure so
// parseRule.ts and loadRules (Task 2) can both be unit-tested without disk
// or Electron.
export type RuleActivation = 'always' | 'manual' | 'model' | 'glob'

export interface Rule {
  name: string // filename minus .md, kebab case as-is
  body: string // markdown body after frontmatter, cross-refs resolved later
  activation: RuleActivation
  globs: string[] // only meaningful for 'glob'
  description: string // required for 'model'; '' otherwise if absent
  source: 'project' | 'global'
  error?: string // set when the file is malformed; assembly skips
  warnings?: string[] // non-fatal issues (e.g. unresolved cross-refs), set at load time
}

export interface AgentsContent {
  rules: Rule[]
}
