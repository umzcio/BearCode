import { existsSync, lstatSync } from 'fs'
import { join } from 'path'
import { listDirJailed } from '../fsCapped'
import type { ImportedConfigRow } from '../db'
import type { DetectedSource, ImportTool } from './types'

const INSTRUCTION_FILES: { rel: string; tool: ImportTool }[] = [
  { rel: 'CLAUDE.md', tool: 'claude-code' },
  { rel: 'AGENTS.md', tool: 'codex' },
  { rel: '.cursorrules', tool: 'cursor' },
  { rel: '.windsurfrules', tool: 'windsurf' }
]

// `.md` everywhere, plus `.mdc` for the Cursor/Windsurf rules directories:
// Cursor's modern project-rules format IS `.cursor/rules/*.mdc` (MDC, with
// description/globs/alwaysApply frontmatter), and plain `.md` there is the
// unusual case -- filtering on `.md` alone found nothing for real Cursor
// users (final review Finding 8).
function listMdFilesRel(
  projectPath: string,
  dirRel: string,
  exts: string[] = ['.md']
): string[] {
  const dir = join(projectPath, dirRel)
  return listDirJailed(dir, {
    root: projectPath,
    filter: (d) => exts.some((e) => d.name.endsWith(e))
  }).map((d) => join(dirRel, d.name))
}

const RULE_DIR_EXTS = ['.md', '.mdc']

function listSkillDirsRel(projectPath: string, dirRel: string): string[] {
  const dir = join(projectPath, dirRel)
  return listDirJailed(dir, {
    root: projectPath,
    filter: (d, dir) => d.isDirectory() && existsSync(join(dir, d.name, 'SKILL.md'))
  }).map((d) => join(dirRel, d.name))
}

// Cheap existence-only scan (no parsing) for external agent-tool config,
// mirroring hasProjectAgentsConfig's cheapness in agentsDir/index.ts.
export function scanImportableConfig(projectPath: string): DetectedSource[] {
  const found: DetectedSource[] = []

  for (const { rel, tool } of INSTRUCTION_FILES) {
    const abs = join(projectPath, rel)
    let isSymlink = false
    try {
      isSymlink = lstatSync(abs).isSymbolicLink()
    } catch {
      // doesn't exist — fall through, existsSync below will also be false
    }
    if (!isSymlink && existsSync(abs)) {
      found.push({ sourcePath: rel, kind: 'rule', tool })
    }
  }
  for (const rel of listMdFilesRel(projectPath, join('.cursor', 'rules'), RULE_DIR_EXTS)) {
    found.push({ sourcePath: rel, kind: 'rule', tool: 'cursor' })
  }
  for (const rel of listMdFilesRel(projectPath, join('.windsurf', 'rules'), RULE_DIR_EXTS)) {
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
// IMPORTABLE detected source has no DB row at all, or was dismissed >= 7 days
// ago.
//
// 'unsupported' sources (e.g. `.claude/agents/*.md`, common in real repos) are
// excluded from the decision (final review Finding 2): the renderer's
// dismissImportBanner only ever dismisses kind !== 'unsupported' paths, so an
// unsupported source could never get a `dismissed` row and would make the
// banner reappear on every folder open, forever, un-silenceable via "Not now".
export function shouldShowImportBanner(
  detected: DetectedSource[],
  known: ImportedConfigRow[],
  nowMs: number
): boolean {
  const byPath = new Map(known.map((k) => [k.sourcePath, k]))
  return detected.some((d) => {
    if (d.kind === 'unsupported') return false
    const row = byPath.get(d.sourcePath)
    if (!row) return true
    if (row.status === 'dismissed') {
      return row.dismissedAt !== null && nowMs - row.dismissedAt >= REMIND_AFTER_MS
    }
    return false
  })
}
