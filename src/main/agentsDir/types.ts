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

// Workflow types for the .agents/ workflows spine (design 3.1/5.1-5.4,
// D2 Task 1). A Workflow is the parsed shape of one .agents/workflows/*.md
// (or ~/.bearcode/agents/workflows/*.md) file: filename (minus .md) is the
// command name, an optional frontmatter `description:` is used by the slash
// menu, and the body's markdown steps drive the workflow's todo plan at turn
// start (Task 2). Unlike Rule, a workflow body gets NO @-cross-ref
// resolution (design 3.1 specifies refs for rules only) -- a `@x` token in a
// workflow body stays literal.
export interface Workflow {
  name: string // filename minus .md, kebab case as-is
  description: string // '' when absent; from frontmatter only
  body: string // markdown body after frontmatter, @-refs NOT resolved
  steps: string[] // extracted top-level list items (or one whole-body step)
  source: 'project' | 'global'
  error?: string // set when the file is malformed or misnamed; menu greys it
  warnings?: string[] // non-fatal issues (e.g. truncation), set at load time
}

export interface AgentsContent {
  rules: Rule[]
  workflows: Workflow[]
}
