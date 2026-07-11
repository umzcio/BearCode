import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  writeMemory,
  addMemory,
  updateMemory,
  deleteMemory,
  listMemory,
  promoteMemory,
  MAX_MEMORY_BYTES
} from './index'
import { loadMemory } from '../agentsDir/memory'

let proj: string
beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'bc-memw-'))
})
afterEach(() => rmSync(proj, { recursive: true, force: true }))

describe('writeMemory (path-jailed, 16KB cap)', () => {
  it('writes .agents/memory/memory.md for project scope', () => {
    writeMemory('project', ['fact one', 'fact two'], proj)
    const p = join(proj, '.agents', 'memory', 'memory.md')
    expect(existsSync(p)).toBe(true)
    expect(readFileSync(p, 'utf8')).toContain('- fact one')
  })
  it('rejects a body over the 16KB cap', () => {
    const big = 'x'.repeat(MAX_MEMORY_BYTES)
    expect(() => writeMemory('project', [big], proj)).toThrow(/prune/i)
  })
  it('project scope with no project path throws', () => {
    expect(() => writeMemory('project', ['a'], null)).toThrow()
  })
})

describe('addMemory (append)', () => {
  it('appends a bullet and reports ok', () => {
    expect(addMemory('project', 'first', proj)).toBe('ok')
    expect(addMemory('project', 'second', proj)).toBe('ok')
    expect(loadMemory(proj).project.map((e) => e.text)).toEqual(['first', 'second'])
  })
  it('returns "full" instead of throwing when the append would exceed the cap', () => {
    writeMemory('project', ['x'.repeat(MAX_MEMORY_BYTES - 100)], proj)
    expect(addMemory('project', 'y'.repeat(500), proj)).toBe('full')
  })
})

describe('update/delete by index', () => {
  it('updates the addressed bullet', () => {
    writeMemory('project', ['a', 'b', 'c'], proj)
    updateMemory('project', 1, 'B!', proj)
    expect(loadMemory(proj).project.map((e) => e.text)).toEqual(['a', 'B!', 'c'])
  })
  it('deletes the addressed bullet and reindexes', () => {
    writeMemory('project', ['a', 'b', 'c'], proj)
    deleteMemory('project', 0, proj)
    expect(loadMemory(proj).project.map((e) => e.text)).toEqual(['b', 'c'])
  })
})

describe('listMemory', () => {
  it('returns both scopes with sizes', () => {
    writeMemory('project', ['a', 'b'], proj)
    const list = listMemory(proj)
    expect(list.project.entries.map((e) => e.text)).toEqual(['a', 'b'])
    expect(list.project.sizeBytes).toBeGreaterThan(0)
    expect(list.global.entries).toEqual([])
  })
})

describe('promoteMemory', () => {
  it('promotes a bullet to a project rule and drops the bullet', () => {
    writeMemory('project', ['always use tabs', 'keep'], proj)
    promoteMemory({ scope: 'project', index: 0, target: 'rule', name: 'tabs-rule' }, proj)
    expect(existsSync(join(proj, '.agents', 'rules', 'tabs-rule.md'))).toBe(true)
    expect(loadMemory(proj).project.map((e) => e.text)).toEqual(['keep'])
  })
  it('promotes a bullet to a project skill (name + description) and drops the bullet', () => {
    writeMemory('project', ['run the suite with pnpm test'], proj)
    promoteMemory(
      {
        scope: 'project',
        index: 0,
        target: 'skill',
        name: 'run-tests',
        description: 'How to run tests.'
      },
      proj
    )
    expect(existsSync(join(proj, '.agents', 'skills', 'run-tests', 'SKILL.md'))).toBe(true)
    expect(loadMemory(proj).project).toEqual([])
  })
  it('does NOT drop the bullet if the promotion write fails', () => {
    writeMemory('project', ['x'], proj)
    expect(() =>
      promoteMemory({ scope: 'project', index: 0, target: 'skill', name: 'no-desc' }, proj)
    ).toThrow()
    expect(loadMemory(proj).project.map((e) => e.text)).toEqual(['x'])
  })
})
