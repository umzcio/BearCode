import { join } from 'path'
import { readFileCapped } from '../fsCapped'
import { resolveRuleRefs } from '../agentsDir'
import type { DetectedSource } from './types'

const MAX_IMPORT_BYTES = 64 * 1024

export interface RuleCandidate {
  sourcePath: string
  suggestedName: string
  body: string
  warnings: string[]
}

// Kebab-cases the source file's basename (minus extension and any leading
// dot) into a rule name. "CLAUDE.md" -> "claude", ".cursorrules" ->
// "cursorrules", ".cursor/rules/testing.md" -> "testing".
function nameFromSourcePath(sourcePath: string): string {
  const base = sourcePath.split(/[/\\]/).pop() ?? sourcePath
  const stem = base.replace(/\.md$/, '').replace(/^\.+/, '')
  const kebab = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return kebab === '' ? 'imported-rule' : kebab
}

export function buildRuleCandidate(
  projectPath: string,
  source: DetectedSource
): RuleCandidate | null {
  const abs = join(projectPath, source.sourcePath)
  const read = readFileCapped(abs, MAX_IMPORT_BYTES)
  if (!read || read.text.trim() === '') return null

  const { body, warnings } = resolveRuleRefs(read.text, projectPath, {
    inlinedChain: new Set([abs])
  })

  return {
    sourcePath: source.sourcePath,
    suggestedName: nameFromSourcePath(source.sourcePath),
    body,
    warnings: read.truncated
      ? [...warnings, `${source.sourcePath} exceeds ${MAX_IMPORT_BYTES / 1024}KB and was truncated`]
      : warnings
  }
}
