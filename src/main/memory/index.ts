// Path-jailed memory writes + the settings-page list/promote model (design
// 4.3/4.4/4.5). Mirrors src/main/skills/index.ts: every write resolves under
// the scope's memory root and is guarded by a 16KB soft cap before touching
// disk. Bodies are a "- " bullet list, one bullet per entry.
import { mkdirSync, writeFileSync } from 'fs'
import { join, resolve, sep } from 'path'
import type { MemoryList, MemoryPromoteInput, MemoryScopeName } from '../../shared/types'
import { memoryDir, loadMemory, serializeMemoryBullets } from '../agentsDir/memory'
import { writeRuleFile } from '../rules'
import { writeSkillFile } from '../skills'

export const MAX_MEMORY_BYTES = 16 * 1024

export class MemoryFullError extends Error {
  constructor() {
    super(`Memory full — prune entries in Settings (soft cap ${MAX_MEMORY_BYTES / 1024}KB).`)
    this.name = 'MemoryFullError'
  }
}

// Jailed memory.md path: the resolved file must sit exactly at
// <root>/memory.md, never above it (the jailPath idiom, Global Constraints).
function jailedMemoryFile(scope: MemoryScopeName, projectPath: string | null): string {
  const root = resolve(memoryDir(scope, projectPath))
  const file = resolve(root, 'memory.md')
  if (file !== join(root, 'memory.md') || !file.startsWith(root + sep)) {
    throw new Error('Invalid memory path (path traversal rejected).')
  }
  return file
}

export function writeMemory(
  scope: MemoryScopeName,
  texts: string[],
  projectPath: string | null
): void {
  const body = serializeMemoryBullets(texts)
  if (Buffer.byteLength(body, 'utf8') > MAX_MEMORY_BYTES) throw new MemoryFullError()
  const file = jailedMemoryFile(scope, projectPath)
  mkdirSync(resolve(file, '..'), { recursive: true })
  writeFileSync(file, body)
}

function currentTexts(scope: MemoryScopeName, projectPath: string | null): string[] {
  const mem = loadMemory(scope === 'project' ? projectPath : null)
  return (scope === 'global' ? mem.global : mem.project).map((e) => e.text)
}

// Append one bullet. Returns 'full' (no write) when the append would breach the
// cap, so the caller surfaces a "prune" message instead of losing the write.
export function addMemory(
  scope: MemoryScopeName,
  text: string,
  projectPath: string | null
): 'ok' | 'full' {
  const next = [...currentTexts(scope, projectPath), text]
  try {
    writeMemory(scope, next, projectPath)
    return 'ok'
  } catch (err) {
    if (err instanceof MemoryFullError) return 'full'
    throw err
  }
}

export function updateMemory(
  scope: MemoryScopeName,
  index: number,
  text: string,
  projectPath: string | null
): void {
  const texts = currentTexts(scope, projectPath)
  if (index < 0 || index >= texts.length) throw new Error('Memory entry index out of range.')
  texts[index] = text
  writeMemory(scope, texts, projectPath)
}

export function deleteMemory(
  scope: MemoryScopeName,
  index: number,
  projectPath: string | null
): void {
  const texts = currentTexts(scope, projectPath)
  if (index < 0 || index >= texts.length) throw new Error('Memory entry index out of range.')
  texts.splice(index, 1)
  writeMemory(scope, texts, projectPath)
}

// The settings-page read model (design 4.6): both scopes, each with its entries
// and on-disk byte size (the page shows per-scope size, design 4.4).
export function listMemory(projectPath: string | null): MemoryList {
  const mem = loadMemory(projectPath)
  const size = (entries: { text: string }[]): number =>
    Buffer.byteLength(serializeMemoryBullets(entries.map((e) => e.text)), 'utf8')
  return {
    global: { entries: mem.global, sizeBytes: size(mem.global) },
    project: { entries: mem.project, sizeBytes: size(mem.project) }
  }
}

// Promote a bullet to a Rule or Skill, THEN drop the source bullet — never
// before, so a write failure can't lose the memory (design 4.5, the updateSkill
// rename ordering precedent). Skill requires a description; rule is authored
// 'always'.
export function promoteMemory(input: MemoryPromoteInput, projectPath: string | null): void {
  const texts = currentTexts(input.scope, projectPath)
  if (input.index < 0 || input.index >= texts.length) {
    throw new Error('Memory entry index out of range.')
  }
  const body = texts[input.index]
  if (input.target === 'rule') {
    writeRuleFile(input.name, body, 'always', input.scope, projectPath)
  } else {
    if (!input.description || input.description.trim() === '') {
      throw new Error('A description is required to promote memory to a skill.')
    }
    writeSkillFile(
      { name: input.name, description: input.description, body, scope: input.scope },
      projectPath
    )
  }
  deleteMemory(input.scope, input.index, projectPath)
}
