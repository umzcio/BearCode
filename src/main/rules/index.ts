// Path-jailed rule writes (Memory arc, design 4.5). Net-new: the agents engine
// could not author .agents/rules until now (only activate_rule toggled existing
// rules). Mirrors src/main/skills/index.ts exactly — jailPath containment before
// any mkdir/write, kebab-case names, a 64KB cap matching the loader's
// MAX_RULE_BYTES — and produces the frontmatter parseRule.ts reads.
import { mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join, resolve, sep } from 'path'
import { COMMAND_NAME_PATTERN } from '../../shared/types'
import type { RuleEntry } from '../../shared/types'
import { loadAgentsContent } from '../agentsDir'
import type { RuleActivation } from '../agentsDir/types'

const MAX_RULE_BYTES = 64 * 1024

export function rulesDir(scope: 'project' | 'global', projectPath: string | null): string {
  if (scope === 'global') return join(homedir(), '.bearcode', 'agents', 'rules')
  if (!projectPath) throw new Error('A project must be open to write a project-scope rule.')
  return join(projectPath, '.agents', 'rules')
}

function jailedRuleFile(
  name: string,
  scope: 'project' | 'global',
  projectPath: string | null
): string {
  if (!COMMAND_NAME_PATTERN.test(name)) {
    throw new Error('Rule name must be kebab-case (lowercase letters, digits, dashes).')
  }
  const root = resolve(rulesDir(scope, projectPath))
  const file = resolve(root, `${name}.md`)
  if (file !== join(root, `${name}.md`) || !file.startsWith(root + sep)) {
    throw new Error('Invalid rule name (path traversal rejected).')
  }
  return file
}

// Frontmatter parseRuleFile reads (frontmatter.ts recognizes activation/
// description/globs). A description line is emitted only when non-empty, so an
// 'always' promotion produces a minimal block that parses with no error.
export function renderRuleMd(body: string, activation: RuleActivation, description = ''): string {
  const lines = ['---', `activation: ${activation}`]
  if (description.trim() !== '') lines.push(`description: ${description}`)
  lines.push('---', '', body, '')
  return lines.join('\n')
}

export function writeRuleFile(
  name: string,
  body: string,
  activation: RuleActivation,
  scope: 'project' | 'global',
  projectPath: string | null
): void {
  const md = renderRuleMd(body, activation)
  if (Buffer.byteLength(md, 'utf8') > MAX_RULE_BYTES) {
    throw new Error(`Rule exceeds the ${MAX_RULE_BYTES / 1024}KB size cap.`)
  }
  const file = jailedRuleFile(name, scope, projectPath)
  mkdirSync(resolve(file, '..'), { recursive: true })
  writeFileSync(file, md)
}

// The Settings > Rules page's list read model (Phase G plugins arc, Task 12
// fix). Rules stay file-managed only -- there is no update/delete here, same
// as workflows -- this just projects the live AgentsContent.rules into the
// wire-shaped RuleEntry, parallel to skills/index.ts's listSkillEntries.
export function listRuleEntries(projectPath: string | null): RuleEntry[] {
  // Settings-page management view: show project rules regardless of trust so
  // the user can see every rule, including a not-yet-trusted project's
  // (mirrors listSkillEntries -- this is NOT the agent-facing path, which
  // gates on trust in loadAgentsContent's caller at turn-build time).
  return loadAgentsContent(projectPath, { trusted: true }).rules.map((r) => ({
    name: r.name,
    description: r.description,
    activation: r.activation,
    source: r.source,
    error: r.error,
    plugin: r.plugin
  }))
}
