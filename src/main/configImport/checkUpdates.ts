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
import { hashSourceContent, MAX_IMPORT_BYTES } from './hash'
import { buildRuleCandidate } from './translateRules'
import { buildWorkflowCandidate } from './translateWorkflows'
import type { ImportedConfigRow } from '../db'

export type UpdateCheck =
  | { state: 'up-to-date' }
  | { state: 'changed'; oldBody: string; newBody: string }
  | { state: 'source-missing' }

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
  }
}

function candidateBody(projectPath: string, sourcePath: string): string | null {
  const source = scanImportableConfig(projectPath).find((d) => d.sourcePath === sourcePath)
  if (!source) return null
  if (source.kind === 'rule') {
    // Thread the same outside-of-folder policy the live loader (and the
    // importer) use, and record anything dropped-pending so it surfaces in
    // OutsideAccessCard (final review Finding 1). Re-translating on update is
    // just as irreversible as the first import.
    const candidate = buildRuleCandidate(projectPath, source, getOutsidePolicy(projectPath))
    if (!candidate) return null
    for (const abs of candidate.pendingOutside) recordPendingOutsidePath(projectPath, abs)
    return candidate.body
  }
  if (source.kind === 'workflow') return buildWorkflowCandidate(projectPath, source)?.body ?? null
  return null // skills are diffed as whole folders — out of scope for the text-diff check
}

export function checkSourceForUpdate(projectPath: string, sourcePath: string): UpdateCheck {
  const row = getImportedConfig(projectPath, sourcePath)
  const abs = join(projectPath, sourcePath)
  if (!existsSync(abs)) return { state: 'source-missing' }

  // Capped, non-regular-rejecting, directory-safe (Finding 5): a skill row's
  // sourcePath is a FOLDER, which the old readFileSync(abs) threw EISDIR on.
  const currentHash = hashSourceContent(projectPath, sourcePath)
  if (currentHash === null) return { state: 'source-missing' }
  if (row?.sourceHash === currentHash) return { state: 'up-to-date' }

  const newBody = candidateBody(projectPath, sourcePath)
  if (newBody === null || !row?.importedAsType || !row.importedAsName) return { state: 'up-to-date' }

  const dir = importedDirFor(projectPath, row.importedAsType)
  if (dir === null) return { state: 'up-to-date' }
  // Capped read here too, for the same reason the source side is capped: this
  // path is under the user's control and could have been replaced by hand with
  // an oversized or non-regular file since the import.
  const oldPath = join(dir, `${row.importedAsName}.md`)
  const oldBody = readFileCapped(oldPath, MAX_IMPORT_BYTES)?.text ?? ''
  return { state: 'changed', oldBody, newBody }
}

export function applySourceUpdate(projectPath: string, sourcePath: string): void {
  const row = getImportedConfig(projectPath, sourcePath)
  if (!row?.importedAsType || !row.importedAsName) return
  const newBody = candidateBody(projectPath, sourcePath)
  if (newBody === null) return
  const sourceHash = hashSourceContent(projectPath, sourcePath)
  if (sourceHash === null) return
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
