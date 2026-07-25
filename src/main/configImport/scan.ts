import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import type { ImportedConfigRow } from '../db'
import type { DetectedSource, ImportTool } from './types'

const INSTRUCTION_FILES: { rel: string; tool: ImportTool }[] = [
  { rel: 'CLAUDE.md', tool: 'claude-code' },
  { rel: 'AGENTS.md', tool: 'codex' },
  { rel: '.cursorrules', tool: 'cursor' },
  { rel: '.windsurfrules', tool: 'windsurf' }
]

function listMdFilesRel(projectPath: string, dirRel: string): string[] {
  const dir = join(projectPath, dirRel)
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => join(dirRel, f))
  } catch {
    return []
  }
}

function listSkillDirsRel(projectPath: string, dirRel: string): string[] {
  const dir = join(projectPath, dirRel)
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'SKILL.md')))
      .map((d) => join(dirRel, d.name))
  } catch {
    return []
  }
}

// Cheap existence-only scan (no parsing) for external agent-tool config,
// mirroring hasProjectAgentsConfig's cheapness in agentsDir/index.ts.
export function scanImportableConfig(projectPath: string): DetectedSource[] {
  const found: DetectedSource[] = []

  for (const { rel, tool } of INSTRUCTION_FILES) {
    if (existsSync(join(projectPath, rel))) {
      found.push({ sourcePath: rel, kind: 'rule', tool })
    }
  }
  for (const rel of listMdFilesRel(projectPath, join('.cursor', 'rules'))) {
    found.push({ sourcePath: rel, kind: 'rule', tool: 'cursor' })
  }
  for (const rel of listMdFilesRel(projectPath, join('.windsurf', 'rules'))) {
    found.push({ sourcePath: rel, kind: 'rule', tool: 'windsurf' })
  }
  for (const rel of listMdFilesRel(projectPath, join('.claude', 'commands'))) {
    found.push({ sourcePath: rel, kind: 'workflow', tool: 'claude-code' })
  }
  for (const rel of listSkillDirsRel(projectPath, join('.claude', 'skills'))) {
    found.push({ sourcePath: rel, kind: 'skill', tool: 'claude-code' })
  }
  for (const rel of listMdFilesRel(projectPath, join('.claude', 'agents'))) {
    found.push({ sourcePath: rel, kind: 'unsupported', tool: 'claude-code' })
  }
  return found
}

const REMIND_AFTER_MS = 7 * 24 * 60 * 60 * 1000

// Pure decision function (no Date.now() inside — the caller supplies `nowMs`
// so this stays trivially testable). Shows the banner when at least one
// detected source has no DB row at all, or was dismissed >= 7 days ago.
export function shouldShowImportBanner(
  detected: DetectedSource[],
  known: ImportedConfigRow[],
  nowMs: number
): boolean {
  const byPath = new Map(known.map((k) => [k.sourcePath, k]))
  return detected.some((d) => {
    const row = byPath.get(d.sourcePath)
    if (!row) return true
    if (row.status === 'dismissed') {
      return row.dismissedAt !== null && nowMs - row.dismissedAt >= REMIND_AFTER_MS
    }
    return false
  })
}
