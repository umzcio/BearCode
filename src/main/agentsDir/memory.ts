// Dual-scope memory loader for the .agents/ spine (design 4.1/4.7). Reads
// ~/.bearcode/agents/memory/memory.md (global) and
// <project>/.agents/memory/memory.md (project) as a markdown bullet list —
// one "- " bullet = one MemoryEntry — and injects always-on
// (contextAssembly.ts). Pure Node builtins; reuses the loader's bounded
// readFileCapped (64KB) so an oversized file is truncated, never read whole,
// and a missing/unreadable file yields []. Never throws.
import { homedir } from 'os'
import { join } from 'path'
import type { MemoryEntry, MemoryScopeName } from '../../shared/types'
import { readFileCapped } from './index'

const MAX_MEMORY_READ_BYTES = 64 * 1024

export function memoryDir(scope: MemoryScopeName, projectPath: string | null): string {
  if (scope === 'global') return join(homedir(), '.bearcode', 'agents', 'memory')
  if (!projectPath) throw new Error('A project must be open to address project-scope memory.')
  return join(projectPath, '.agents', 'memory')
}

// Parse a memory.md body into indexed entries. Only top-level "- " list items
// count; every other line (headings, blanks, prose) is ignored. `index` is the
// entry's ordinal among the kept bullets (the stable edit/delete/promote key).
export function parseMemoryBullets(raw: string, scope: MemoryScopeName): MemoryEntry[] {
  const text = raw.replace(/\r\n/g, '\n')
  const entries: MemoryEntry[] = []
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*-\s+(.*\S)\s*$/)
    if (!m) continue
    entries.push({ scope, index: entries.length, text: m[1] })
  }
  return entries
}

// Serialize a list of entry texts to a memory.md body: one "- " bullet per
// line. Embedded newlines are collapsed to spaces so one bullet stays one line
// (the parse invariant round-trips).
export function serializeMemoryBullets(texts: string[]): string {
  if (texts.length === 0) return ''
  return texts.map((t) => `- ${t.replace(/\s*\n\s*/g, ' ').trim()}`).join('\n') + '\n'
}

function loadScope(scope: MemoryScopeName, projectPath: string | null): MemoryEntry[] {
  let dir: string
  try {
    dir = memoryDir(scope, projectPath)
  } catch {
    return [] // project scope with no project open
  }
  const read = readFileCapped(join(dir, 'memory.md'), MAX_MEMORY_READ_BYTES)
  if (!read) return []
  return parseMemoryBullets(read.text, scope)
}

export function loadMemory(projectPath: string | null): {
  global: MemoryEntry[]
  project: MemoryEntry[]
} {
  return {
    global: loadScope('global', null),
    project: projectPath ? loadScope('project', projectPath) : []
  }
}
