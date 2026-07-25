import { existsSync, mkdirSync, writeFileSync, cpSync, readFileSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { scanImportableConfig } from './scan'
import { buildRuleCandidate } from './translateRules'
import { buildWorkflowCandidate } from './translateWorkflows'
import { buildSkillCandidate } from './translateSkills'
import { upsertImportedConfig } from '../db'

export interface ImportSelection {
  rules: string[]
  workflows: string[]
  skills: string[]
}

export interface ImportSummary {
  rulesImported: number
  workflowsImported: number
  skillsImported: number
}

// Picks the first available filename by appending "-imported", then
// "-imported-2", "-imported-3", ... — never overwrites an existing file.
function uniqueTargetPath(dir: string, baseName: string, ext: string): string {
  const plain = join(dir, `${baseName}${ext}`)
  if (!existsSync(plain)) return plain
  const withSuffix = join(dir, `${baseName}-imported${ext}`)
  if (!existsSync(withSuffix)) return withSuffix
  let n = 2
  while (existsSync(join(dir, `${baseName}-imported-${n}${ext}`))) n++
  return join(dir, `${baseName}-imported-${n}${ext}`)
}

// Same collision-suffixing scheme as uniqueTargetPath, but for a directory
// (skill folders are copied whole, not written as a single file).
function uniqueTargetDirName(dir: string, baseName: string): string {
  if (!existsSync(join(dir, baseName))) return baseName
  const withSuffix = `${baseName}-imported`
  if (!existsSync(join(dir, withSuffix))) return withSuffix
  let n = 2
  while (existsSync(join(dir, `${baseName}-imported-${n}`))) n++
  return `${baseName}-imported-${n}`
}

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function applyImportSelection(
  projectPath: string,
  selection: ImportSelection
): ImportSummary {
  const detected = scanImportableConfig(projectPath)
  const bySourcePath = new Map(detected.map((d) => [d.sourcePath, d]))
  const summary: ImportSummary = { rulesImported: 0, workflowsImported: 0, skillsImported: 0 }

  const rulesDir = join(projectPath, '.agents', 'rules')
  for (const sourcePath of selection.rules) {
    const source = bySourcePath.get(sourcePath)
    if (!source) continue
    const candidate = buildRuleCandidate(projectPath, source)
    if (!candidate) continue
    mkdirSync(rulesDir, { recursive: true })
    const target = uniqueTargetPath(rulesDir, candidate.suggestedName, '.md')
    writeFileSync(target, candidate.body)
    const rawText = readFileSync(join(projectPath, sourcePath), 'utf8')
    upsertImportedConfig(projectPath, sourcePath, {
      sourceHash: hashOf(rawText),
      importedAsType: 'rule',
      importedAsName: target.slice(rulesDir.length + 1).replace(/\.md$/, ''),
      status: 'imported',
      createdAt: Date.now()
    })
    summary.rulesImported++
  }

  const workflowsDir = join(projectPath, '.agents', 'workflows')
  for (const sourcePath of selection.workflows) {
    const source = bySourcePath.get(sourcePath)
    if (!source) continue
    const candidate = buildWorkflowCandidate(projectPath, source)
    if (!candidate) continue
    mkdirSync(workflowsDir, { recursive: true })
    const target = uniqueTargetPath(workflowsDir, candidate.suggestedName, '.md')
    writeFileSync(target, candidate.body)
    const rawText = readFileSync(join(projectPath, sourcePath), 'utf8')
    upsertImportedConfig(projectPath, sourcePath, {
      sourceHash: hashOf(rawText),
      importedAsType: 'workflow',
      importedAsName: target.slice(workflowsDir.length + 1).replace(/\.md$/, ''),
      status: 'imported',
      createdAt: Date.now()
    })
    summary.workflowsImported++
  }

  const skillsDir = join(projectPath, '.agents', 'skills')
  for (const sourcePath of selection.skills) {
    const source = bySourcePath.get(sourcePath)
    if (!source) continue
    const candidate = buildSkillCandidate(projectPath, source)
    if (!candidate) continue
    mkdirSync(skillsDir, { recursive: true })
    const targetName = uniqueTargetDirName(skillsDir, candidate.suggestedName)
    cpSync(join(projectPath, sourcePath), join(skillsDir, targetName), { recursive: true })
    const rawText = readFileSync(join(projectPath, sourcePath, 'SKILL.md'), 'utf8')
    upsertImportedConfig(projectPath, sourcePath, {
      sourceHash: hashOf(rawText),
      importedAsType: 'skill',
      importedAsName: targetName,
      status: 'imported',
      createdAt: Date.now()
    })
    summary.skillsImported++
  }

  return summary
}
