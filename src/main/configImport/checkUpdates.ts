import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { readFileCapped } from '../fsCapped'
import {
  getImportedConfig,
  upsertImportedConfig,
  deleteImportedConfig,
  getOutsidePolicy,
  recordPendingOutsidePath
} from '../db'
import { scanImportableConfig } from './scan'
import { hashSourceContent, readAndHashSource, MAX_IMPORT_BYTES } from './hash'
import { buildRuleCandidate } from './translateRules'
import { buildWorkflowCandidate } from './translateWorkflows'
import type { ImportedConfigRow } from '../db'

export type UpdateCheck =
  | { state: 'up-to-date' }
  | { state: 'changed'; oldBody: string; newBody: string }
  | { state: 'source-missing' }
  | { state: 'changed-unparseable' }

// Where an imported entity of each type lives under .agents/. An explicit
// exhaustive switch rather than a `=== 'rule' ? 'rules' : 'workflows'` ternary
// (final review Minor): the ternary silently routed 'skill' to 'workflows',
// harmless only because candidateBody returns null for skills first. Returning
// null for 'skill' here means a future change to that early return can never
// silently write a skill's body into .agents/workflows/.
function importedDirFor(
  projectPath: string,
  type: NonNullable<ImportedConfigRow['importedAsType']>
): string | null {
  switch (type) {
    case 'rule':
      return join(projectPath, '.agents', 'rules')
    case 'workflow':
      return join(projectPath, '.agents', 'workflows')
    case 'skill':
      // Skills are folders, not a single .md body -- diffed/updated as whole
      // directories, which the text-diff update flow does not handle.
      return null
    case 'mcp':
      // MCP servers are import-once in this plan (Global Constraints) --
      // "Check for updates" is not built for them, matching Skills above.
      return null
  }
}

function candidateBody(
  projectPath: string,
  sourcePath: string,
  preRead?: { text: string; truncated: boolean }
): string | null {
  const source = scanImportableConfig(projectPath).find((d) => d.sourcePath === sourcePath)
  if (!source) return null
  if (source.kind === 'rule') {
    // Thread the same outside-of-folder policy the live loader (and the
    // importer) use, and record anything dropped-pending so it surfaces in
    // OutsideAccessCard (final review Finding 1). Re-translating on update is
    // just as irreversible as the first import.
    const candidate = buildRuleCandidate(projectPath, source, getOutsidePolicy(projectPath), preRead)
    if (!candidate) return null
    for (const abs of candidate.pendingOutside) recordPendingOutsidePath(projectPath, abs)
    return candidate.body
  }
  if (source.kind === 'workflow') return buildWorkflowCandidate(projectPath, source, preRead)?.body ?? null
  return null // skills are diffed as whole folders — out of scope for the text-diff check
}

export function checkSourceForUpdate(projectPath: string, sourcePath: string): UpdateCheck {
  const row = getImportedConfig(projectPath, sourcePath)
  const abs = join(projectPath, sourcePath)
  if (!existsSync(abs)) return { state: 'source-missing' }

  // Capped, non-regular-rejecting, directory-safe (Finding 5): a skill row's
  // sourcePath is a FOLDER, which the old readFileSync(abs) threw EISDIR on.
  // Single read shared with candidateBody below (closes a TOCTOU where the
  // source could change between a separate hash-read and body-read).
  const read = readAndHashSource(projectPath, sourcePath)
  if (read === null) return { state: 'source-missing' }
  if (row?.sourceHash === read.hash) return { state: 'up-to-date' }

  const newBody = candidateBody(projectPath, sourcePath, read)
  if (!row?.importedAsType || !row.importedAsName) return { state: 'up-to-date' }
  // candidateBody() only ever computes a real body for 'rule'/'workflow' sources
  // -- it always returns null for 'skill'/'mcp' by design (skills are diffed as
  // whole folders; MCP servers are import-once), not because their content is
  // unparseable. Check the row's type BEFORE inspecting newBody so those two
  // kinds keep reporting up-to-date exactly as before (see the still-passing
  // skill tests), and only a rule/workflow whose hash changed AND whose new
  // content is now unparseable reports 'changed-unparseable'.
  if (row.importedAsType !== 'rule' && row.importedAsType !== 'workflow') {
    return { state: 'up-to-date' }
  }
  if (newBody === null) return { state: 'changed-unparseable' }

  const dir = importedDirFor(projectPath, row.importedAsType)
  if (dir === null) return { state: 'up-to-date' }
  // Capped read here too, for the same reason the source side is capped: this
  // path is under the user's control and could have been replaced by hand with
  // an oversized or non-regular file since the import. `projectPath` as `root`
  // matches every other config-import readFileCapped call site (translateRules,
  // translateWorkflows, translateSkills, hash.ts): without it, a symlink planted
  // at this imported path (e.g. `.agents/rules/<name>.md` swapped for a symlink
  // pointing outside the project) would have its target silently read here.
  const oldPath = join(dir, `${row.importedAsName}.md`)
  const oldBody = readFileCapped(oldPath, MAX_IMPORT_BYTES, projectPath)?.text ?? ''
  return { state: 'changed', oldBody, newBody }
}

export function applySourceUpdate(projectPath: string, sourcePath: string): void {
  const row = getImportedConfig(projectPath, sourcePath)
  if (!row?.importedAsType || !row.importedAsName) return
  const read = readAndHashSource(projectPath, sourcePath)
  if (read === null) return
  const newBody = candidateBody(projectPath, sourcePath, read)
  if (newBody === null) return
  const sourceHash = read.hash
  const dir = importedDirFor(projectPath, row.importedAsType)
  if (dir === null) return
  const target = join(dir, `${row.importedAsName}.md`)
  // The imported file (or its whole directory) can have been deleted by hand
  // since the import; recreate the directory rather than throwing ENOENT
  // (final review Minor).
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, newBody)
  upsertImportedConfig(projectPath, sourcePath, { sourceHash })
}

export function ignoreSourceUpdate(projectPath: string, sourcePath: string): void {
  const sourceHash = hashSourceContent(projectPath, sourcePath)
  if (sourceHash === null) return
  upsertImportedConfig(projectPath, sourcePath, { sourceHash })
}

export function detachSource(projectPath: string, sourcePath: string): void {
  deleteImportedConfig(projectPath, sourcePath)
}

export function dismissDetectedSources(projectPath: string, sourcePaths: string[]): void {
  const now = Date.now()
  for (const sourcePath of Array.from(new Set(sourcePaths))) {
    upsertImportedConfig(projectPath, sourcePath, {
      status: 'dismissed',
      dismissedAt: now,
      createdAt: now
    })
  }
}
