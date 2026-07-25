import { existsSync, mkdirSync, writeFileSync, cpSync } from 'fs'
import { join } from 'path'
import { scanImportableConfig } from './scan'
import { hashSourceContent } from './hash'
import { buildRuleCandidate } from './translateRules'
import { buildWorkflowCandidate } from './translateWorkflows'
import { buildSkillCandidate } from './translateSkills'
import { upsertImportedConfig, getOutsidePolicy, recordPendingOutsidePath } from '../db'
import { discoverLocalServers, importDiscoveredServers } from '../mcp/store'
import { mcpSourcePathFor } from './mcpCandidates'

export interface ImportSelection {
  rules: string[]
  workflows: string[]
  skills: string[]
  mcpServers: string[]
}

export interface ImportSummary {
  rulesImported: number
  workflowsImported: number
  skillsImported: number
  mcpServersImported: number
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

export function applyImportSelection(
  projectPath: string,
  selection: ImportSelection
): ImportSummary {
  const detected = scanImportableConfig(projectPath)
  const bySourcePath = new Map(detected.map((d) => [d.sourcePath, d]))
  const summary: ImportSummary = {
    rulesImported: 0,
    workflowsImported: 0,
    skillsImported: 0,
    mcpServersImported: 0
  }
  // Dedupe within each list (final review Minor): a selection carrying the
  // same sourcePath twice would otherwise import it twice and leave a
  // pointless "-imported-2" duplicate, with only the last write tracked in
  // the DB row.
  const uniq = (paths: string[]): string[] => Array.from(new Set(paths))

  // Same outside-of-folder policy the live loader threads for project rules
  // (Finding 1) -- see buildRuleCandidate's note on why import time needs it.
  const outside = getOutsidePolicy(projectPath)

  const rulesDir = join(projectPath, '.agents', 'rules')
  for (const sourcePath of uniq(selection.rules)) {
    const source = bySourcePath.get(sourcePath)
    if (!source) continue
    const candidate = buildRuleCandidate(projectPath, source, outside)
    if (!candidate) continue
    const sourceHash = hashSourceContent(projectPath, sourcePath)
    if (sourceHash === null) continue
    mkdirSync(rulesDir, { recursive: true })
    const target = uniqueTargetPath(rulesDir, candidate.suggestedName, '.md')
    writeFileSync(target, candidate.body)
    // Surface each dropped out-of-folder ref for explicit allow/deny in the
    // existing OutsideAccessCard, mirroring orchestrator/graph.ts.
    for (const abs of candidate.pendingOutside) recordPendingOutsidePath(projectPath, abs)
    upsertImportedConfig(projectPath, sourcePath, {
      sourceHash,
      importedAsType: 'rule',
      importedAsName: target.slice(rulesDir.length + 1).replace(/\.md$/, ''),
      status: 'imported',
      createdAt: Date.now()
    })
    summary.rulesImported++
  }

  const workflowsDir = join(projectPath, '.agents', 'workflows')
  for (const sourcePath of uniq(selection.workflows)) {
    const source = bySourcePath.get(sourcePath)
    if (!source) continue
    const candidate = buildWorkflowCandidate(projectPath, source)
    if (!candidate) continue
    const sourceHash = hashSourceContent(projectPath, sourcePath)
    if (sourceHash === null) continue
    mkdirSync(workflowsDir, { recursive: true })
    const target = uniqueTargetPath(workflowsDir, candidate.suggestedName, '.md')
    writeFileSync(target, candidate.body)
    upsertImportedConfig(projectPath, sourcePath, {
      sourceHash,
      importedAsType: 'workflow',
      importedAsName: target.slice(workflowsDir.length + 1).replace(/\.md$/, ''),
      status: 'imported',
      createdAt: Date.now()
    })
    summary.workflowsImported++
  }

  const skillsDir = join(projectPath, '.agents', 'skills')
  for (const sourcePath of uniq(selection.skills)) {
    const source = bySourcePath.get(sourcePath)
    if (!source) continue
    const candidate = buildSkillCandidate(projectPath, source)
    if (!candidate) continue
    // hashSourceContent resolves a skill's folder sourcePath to its SKILL.md.
    const sourceHash = hashSourceContent(projectPath, sourcePath)
    if (sourceHash === null) continue
    mkdirSync(skillsDir, { recursive: true })
    const targetName = uniqueTargetDirName(skillsDir, candidate.suggestedName)
    cpSync(join(projectPath, sourcePath), join(skillsDir, targetName), { recursive: true })
    upsertImportedConfig(projectPath, sourcePath, {
      sourceHash,
      importedAsType: 'skill',
      importedAsName: targetName,
      status: 'imported',
      createdAt: Date.now()
    })
    summary.skillsImported++
  }

  const discoveredServers = discoverLocalServers(projectPath)
  const byMcpSourcePath = new Map(
    discoveredServers
      .map((s) => [mcpSourcePathFor(s), s] as const)
      .filter((entry): entry is [string, (typeof discoveredServers)[number]] => entry[0] !== null)
  )
  const selectedServers = uniq(selection.mcpServers)
    .map((sourcePath) => byMcpSourcePath.get(sourcePath))
    .filter((s): s is (typeof discoveredServers)[number] => s !== undefined)
  if (selectedServers.length > 0) {
    const imported = importDiscoveredServers(selectedServers, projectPath)
    // Match each recorded row back to ITS OWN selectedServers entry (not a
    // by-name lookup into `imported`) so two selected servers that happen to
    // share a `name` (e.g. one from .cursor/mcp.json, one from
    // .windsurf/mcp.json) can never cross-attribute a sourcePath.
    const importedNames = new Set(imported.map((cfg) => cfg.name))
    for (const server of selectedServers) {
      if (!importedNames.has(server.name)) continue
      const sourcePath = mcpSourcePathFor(server)
      if (sourcePath === null) continue
      upsertImportedConfig(projectPath, sourcePath, {
        sourceHash: null,
        importedAsType: 'mcp',
        importedAsName: server.name,
        status: 'imported',
        createdAt: Date.now()
      })
    }
    summary.mcpServersImported = imported.length
  }

  return summary
}
