import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { memoryDir, parseMemoryBullets, serializeMemoryBullets, loadMemory } from './memory'

let projectDir: string
let homeDir: string

function writeMemFile(dir: string, body: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'memory.md'), body)
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'bc-mem-proj-'))
  homeDir = mkdtempSync(join(tmpdir(), 'bc-mem-home-'))
  vi.stubEnv('HOME', homeDir)
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(projectDir, { recursive: true, force: true })
  rmSync(homeDir, { recursive: true, force: true })
})

describe('memoryDir', () => {
  it('returns the global root under ~/.bearcode/agents/memory', () => {
    expect(memoryDir('global', null)).toBe(join(homeDir, '.bearcode', 'agents', 'memory'))
  })
  it('returns <project>/.agents/memory for project scope', () => {
    expect(memoryDir('project', projectDir)).toBe(join(projectDir, '.agents', 'memory'))
  })
  it('throws for project scope with no project path', () => {
    expect(() => memoryDir('project', null)).toThrow()
  })
})

describe('parse/serialize bullets', () => {
  it('parses "- " bullets into indexed entries, skipping blanks and non-bullets', () => {
    const entries = parseMemoryBullets(
      '# Memory\n\n- one\n- two\n\nloose line\n- three\n',
      'global'
    )
    expect(entries.map((e) => e.text)).toEqual(['one', 'two', 'three'])
    expect(entries.map((e) => e.index)).toEqual([0, 1, 2])
    expect(entries[0].scope).toBe('global')
  })
  it('serialize round-trips through parse', () => {
    const md = serializeMemoryBullets(['alpha', 'beta'])
    expect(parseMemoryBullets(md, 'project').map((e) => e.text)).toEqual(['alpha', 'beta'])
  })
  it('serialize collapses embedded newlines in a bullet to spaces (one bullet = one line)', () => {
    const md = serializeMemoryBullets(['multi\nline'])
    expect(parseMemoryBullets(md, 'global').map((e) => e.text)).toEqual(['multi line'])
  })
})

describe('loadMemory', () => {
  it('loads both scopes independently', () => {
    writeMemFile(memoryDir('global', null), '- g1\n- g2\n')
    writeMemFile(memoryDir('project', projectDir), '- p1\n')
    const mem = loadMemory(projectDir)
    expect(mem.global.map((e) => e.text)).toEqual(['g1', 'g2'])
    expect(mem.project.map((e) => e.text)).toEqual(['p1'])
  })
  it('missing dirs and no project both yield empty arrays, never throw', () => {
    const mem = loadMemory(null)
    expect(mem.global).toEqual([])
    expect(mem.project).toEqual([])
  })
  it('truncates a memory file past the 64KB read cap without throwing', () => {
    writeMemFile(memoryDir('global', null), '- ' + 'x'.repeat(70 * 1024) + '\n')
    expect(() => loadMemory(projectDir)).not.toThrow()
  })
})
