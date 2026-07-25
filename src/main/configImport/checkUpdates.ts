import { readFileSync, existsSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { getImportedConfig, upsertImportedConfig, deleteImportedConfig } from '../db'
import { scanImportableConfig } from './scan'
import { buildRuleCandidate } from './translateRules'
import { buildWorkflowCandidate } from './translateWorkflows'

export type UpdateCheck =
  | { state: 'up-to-date' }
  | { state: 'changed'; oldBody: string; newBody: string }
  | { state: 'source-missing' }

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function candidateBody(projectPath: string, sourcePath: string): string | null {
  const source = scanImportableConfig(projectPath).find((d) => d.sourcePath === sourcePath)
  if (!source) return null
  if (source.kind === 'rule') return buildRuleCandidate(projectPath, source)?.body ?? null
  if (source.kind === 'workflow') return buildWorkflowCandidate(projectPath, source)?.body ?? null
  return null // skills are diffed as whole folders — out of scope for the text-diff check
}

export function checkSourceForUpdate(projectPath: string, sourcePath: string): UpdateCheck {
  const row = getImportedConfig(projectPath, sourcePath)
  const abs = join(projectPath, sourcePath)
  if (!existsSync(abs)) return { state: 'source-missing' }

  const rawText = readFileSync(abs, 'utf8')
  const currentHash = hashOf(rawText)
  if (row?.sourceHash === currentHash) return { state: 'up-to-date' }

  const newBody = candidateBody(projectPath, sourcePath)
  if (newBody === null || !row?.importedAsType || !row.importedAsName) return { state: 'up-to-date' }

  const dir = join(projectPath, '.agents', row.importedAsType === 'rule' ? 'rules' : 'workflows')
  const oldPath = join(dir, `${row.importedAsName}.md`)
  const oldBody = existsSync(oldPath) ? readFileSync(oldPath, 'utf8') : ''
  return { state: 'changed', oldBody, newBody }
}

export function applySourceUpdate(projectPath: string, sourcePath: string): void {
  const row = getImportedConfig(projectPath, sourcePath)
  if (!row?.importedAsType || !row.importedAsName) return
  const newBody = candidateBody(projectPath, sourcePath)
  if (newBody === null) return
  const dir = join(projectPath, '.agents', row.importedAsType === 'rule' ? 'rules' : 'workflows')
  writeFileSync(join(dir, `${row.importedAsName}.md`), newBody)
  const rawText = readFileSync(join(projectPath, sourcePath), 'utf8')
  upsertImportedConfig(projectPath, sourcePath, { sourceHash: hashOf(rawText) })
}

export function ignoreSourceUpdate(projectPath: string, sourcePath: string): void {
  const abs = join(projectPath, sourcePath)
  if (!existsSync(abs)) return
  const rawText = readFileSync(abs, 'utf8')
  upsertImportedConfig(projectPath, sourcePath, { sourceHash: hashOf(rawText) })
}

export function detachSource(projectPath: string, sourcePath: string): void {
  deleteImportedConfig(projectPath, sourcePath)
}

export function dismissDetectedSources(projectPath: string, sourcePaths: string[]): void {
  const now = Date.now()
  for (const sourcePath of sourcePaths) {
    upsertImportedConfig(projectPath, sourcePath, {
      status: 'dismissed',
      dismissedAt: now,
      createdAt: now
    })
  }
}
