// The @ menu's main-side read models (D3 design 7). File suggestions come from
// a gitignore-respecting `rg --files` listing (the same rgPath fsBackend.ts
// already uses), cached per project with a short TTL so repeated menu opens
// don't re-spawn ripgrep. Manual-rule infos come from the live AgentsContent.
import { execFile } from 'child_process'
import { promisify } from 'util'
import { rgPath } from '@vscode/ripgrep'
import type { AgentsContent } from '../agentsDir/types'
import type { ManualRuleInfo, SkillInfo } from '../../shared/types'

const execFileAsync = promisify(execFile)

// ---- File suggestions ----

interface CacheEntry {
  files: string[]
  fetchedAt: number
}
const cache = new Map<string, CacheEntry>()
const TTL_MS = 5000

async function rgFiles(projectPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(rgPath, ['--files', '--hidden', '-g', '!.git'], {
      cwd: projectPath,
      timeout: 10000,
      maxBuffer: 10 * 1024 * 1024
    })
    return stdout.split('\n').filter(Boolean)
  } catch (err) {
    // rg exits non-zero with partial stdout on some conditions; salvage it.
    const e = err as { stdout?: string }
    return (e.stdout ?? '').split('\n').filter(Boolean)
  }
}

// Interval-cached (TTL) workspace file listing. DOCUMENTED CHOICE: a 5s TTL
// (not mtime-watching) — cheap, and the menu re-fetches on open anyway.
async function listWorkspaceFiles(projectPath: string): Promise<string[]> {
  const now = Date.now()
  const hit = cache.get(projectPath)
  if (hit && now - hit.fetchedAt < TTL_MS) return hit.files
  const files = await rgFiles(projectPath)
  cache.set(projectPath, { files, fetchedAt: now })
  return files
}

function isSubsequence(query: string, hay: string): boolean {
  let i = 0
  for (let j = 0; j < hay.length && i < query.length; j++) {
    if (hay[j] === query[i]) i++
  }
  return i === query.length
}

// Lower is better; null = excluded. Ranks basename first (a match on the file
// name beats a match buried in the directory path), then the full path.
function rankPath(path: string, query: string): number | null {
  const lower = path.toLowerCase()
  const base = lower.slice(lower.lastIndexOf('/') + 1)
  if (base.startsWith(query)) return 0
  if (base.includes(query)) return 1
  if (lower.includes(query)) return 2
  if (isSubsequence(query, lower)) return 3
  return null
}

// Pure ranked filter over a file listing (mirrors slashFilter's approach).
// Empty query returns the listing unchanged. Exported for unit testing.
export function rankFilePaths(paths: string[], query: string): string[] {
  if (query === '') return paths
  const q = query.toLowerCase()
  return paths
    .map((path, index) => ({ path, index, score: rankPath(path, q) }))
    .filter((s): s is { path: string; index: number; score: number } => s.score !== null)
    .sort((a, b) => (a.score !== b.score ? a.score - b.score : a.index - b.index))
    .map((s) => s.path)
}

export async function suggestFiles(projectPath: string | null, query: string): Promise<string[]> {
  if (!projectPath) return []
  const files = await listWorkspaceFiles(projectPath)
  return rankFilePaths(files, query).slice(0, 50)
}

// ---- Manual rules ----

function firstNonEmptyLine(body: string): string {
  for (const line of body.split('\n')) {
    const t = line.trim()
    if (t) return t
  }
  return ''
}

// The @ menu's Rules category (D3 design 7): non-error Manual-mode rules only,
// each with the first non-empty line of its body for the menu row. Pure.
export function manualRuleInfos(content: AgentsContent): ManualRuleInfo[] {
  return content.rules
    .filter((r) => !r.error && r.activation === 'manual')
    .map((r) => ({ name: r.name, firstLine: firstNonEmptyLine(r.body) }))
}

// ---- Skills ----

// The @skill: menu read model (design 4.2 step 3): non-error skills only, with
// their description for the menu row. Disabled-set exclusion happens at the IPC
// boundary (needs the settings store); this stays pure over content.
export function skillInfos(content: AgentsContent): SkillInfo[] {
  return content.skills
    .filter((s) => !s.error)
    .map((s) => ({ name: s.name, description: s.description }))
}
