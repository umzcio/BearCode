// Shared source-content hashing for the import/update-check flow (final
// whole-branch review, Finding 5). Previously `hashOf` was duplicated between
// importer.ts and checkUpdates.ts, and both hashed via a raw
// `readFileSync(abs, 'utf8')`. That broke two of the plan's constraints:
//
//  1. UNCAPPED read: the plan requires every import-side read to go through
//     `readFileCapped` (64KB cap, non-regular-file rejection), so a FIFO or a
//     multi-GB file can never be materialized in the synchronous main process.
//  2. NEVER-THROW contract: a SKILL row's `sourcePath` is a DIRECTORY, so
//     `readFileSync` on it threw EISDIR -- reachable from the shipped
//     config-import:check-update / :ignore-update IPC handlers.
//
// hashSourceContent below closes both: it resolves a directory source to its
// SKILL.md, reads through readFileCapped, and returns null (never throws) when
// the target is missing, a directory with no SKILL.md, or otherwise unreadable.
// Callers treat null the same as their existing "source-missing"/no-op path.
import { createHash } from 'crypto'
import { statSync } from 'fs'
import { join } from 'path'
import { readFileCapped } from '../fsCapped'

// Same cap the translators (and agentsDir's loader) use for rule/workflow/
// skill text. Exported so the translators share one constant.
export const MAX_IMPORT_BYTES = 64 * 1024

export function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

// Hash of the content that identifies a detected source, or null if it cannot
// be read. `sourcePath` is project-relative; a skill source is a folder, in
// which case its SKILL.md is what gets hashed (the folder itself has no
// readable content and hashing it used to throw).
export function hashSourceContent(projectPath: string, sourcePath: string): string | null {
  const abs = join(projectPath, sourcePath)
  let target = abs
  try {
    if (statSync(abs).isDirectory()) target = join(abs, 'SKILL.md')
  } catch {
    return null
  }
  const read = readFileCapped(target, MAX_IMPORT_BYTES)
  return read ? hashOf(read.text) : null
}
