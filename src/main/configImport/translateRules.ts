import { join } from 'path'
import { readFileCapped } from '../fsCapped'
import { resolveRuleRefs, type OutsidePolicy } from '../agentsDir'
import { MAX_IMPORT_BYTES } from './hash'
import type { DetectedSource } from './types'

export interface RuleCandidate {
  sourcePath: string
  suggestedName: string
  body: string
  warnings: string[]
  // Absolute out-of-workspace `@ref` targets that were DROPPED pending the
  // user's explicit allow/deny (see buildRuleCandidate's note). Callers record
  // these via db.recordPendingOutsidePath so they surface in OutsideAccessCard,
  // exactly as the live loader's callers do (orchestrator/graph.ts).
  pendingOutside: string[]
}

// Kebab-cases the source file's basename (minus extension and any leading
// dot) into a rule name. "CLAUDE.md" -> "claude", ".cursorrules" ->
// "cursorrules", ".cursor/rules/testing.md" -> "testing",
// ".cursor/rules/testing.mdc" -> "testing".
function nameFromSourcePath(sourcePath: string): string {
  const base = sourcePath.split(/[/\\]/).pop() ?? sourcePath
  const stem = base.replace(/\.mdc?$/, '').replace(/^\.+/, '')
  const kebab = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return kebab === '' ? 'imported-rule' : kebab
}

// Translate one detected rule source into a writable candidate.
//
// `outside` (final whole-branch review, Finding 1) is the SAME
// outside-of-folder policy the live loader threads for PROJECT rules
// (agentsDir's loadOneRule -> resolveRuleRefs -> resolveRefPath). It MUST be
// supplied at every real call site: inlining happens exactly once, at import
// time, and irreversibly (the `@` token is gone from the written file), so
// without the policy an absolute `@/path/outside/workspace` ref would be
// inlined here with no consent gate and the live gate could never re-evaluate
// it later. Left optional only for tests that deliberately exercise the
// legacy "no policy" branch.
export function buildRuleCandidate(
  projectPath: string,
  source: DetectedSource,
  outside?: OutsidePolicy,
  preRead?: { text: string; truncated: boolean }
): RuleCandidate | null {
  const abs = join(projectPath, source.sourcePath)
  const read = preRead ?? readFileCapped(abs, MAX_IMPORT_BYTES, projectPath)
  if (!read || read.text.trim() === '') return null

  const { body, warnings, pendingOutside } = resolveRuleRefs(read.text, projectPath, {
    outside,
    inlinedChain: new Set([abs])
  })

  return {
    sourcePath: source.sourcePath,
    suggestedName: nameFromSourcePath(source.sourcePath),
    body,
    warnings: read.truncated
      ? [...warnings, `${source.sourcePath} exceeds ${MAX_IMPORT_BYTES / 1024}KB and was truncated`]
      : warnings,
    pendingOutside
  }
}
