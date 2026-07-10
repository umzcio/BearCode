import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeSkillFile, deleteSkillFolder } from './index'

let proj: string
beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'bc-skill-'))
})
afterEach(() => rmSync(proj, { recursive: true, force: true }))

describe('writeSkillFile (path-jailed)', () => {
  it('writes .agents/skills/<name>/SKILL.md for project scope', () => {
    writeSkillFile({ name: 'alpha', description: 'A.', body: 'Body', scope: 'project' }, proj)
    const p = join(proj, '.agents', 'skills', 'alpha', 'SKILL.md')
    expect(existsSync(p)).toBe(true)
    const raw = readFileSync(p, 'utf8')
    expect(raw).toContain('name: alpha')
    expect(raw).toContain('description: A.')
    expect(raw).toContain('Body')
  })
  it('rejects a non-kebab name', () => {
    expect(() =>
      writeSkillFile({ name: '../evil', description: 'x', body: 'b', scope: 'project' }, proj)
    ).toThrow(/kebab/i)
  })
  it('rejects a name with a path separator (traversal)', () => {
    expect(() =>
      writeSkillFile({ name: 'a/b', description: 'x', body: 'b', scope: 'project' }, proj)
    ).toThrow()
  })
  it('rejects an oversize body (64KB cap)', () => {
    const big = 'x'.repeat(65 * 1024)
    expect(() =>
      writeSkillFile({ name: 'big', description: 'x', body: big, scope: 'project' }, proj)
    ).toThrow(/64|size|large/i)
  })
  it('project scope with no project path throws', () => {
    expect(() =>
      writeSkillFile({ name: 'a', description: 'x', body: 'b', scope: 'project' }, null)
    ).toThrow()
  })
})

describe('deleteSkillFolder', () => {
  it('removes the folder', () => {
    writeSkillFile({ name: 'gone', description: 'x', body: 'b', scope: 'project' }, proj)
    deleteSkillFolder('gone', 'project', proj)
    expect(existsSync(join(proj, '.agents', 'skills', 'gone'))).toBe(false)
  })
  it('rejects a traversal name', () => {
    expect(() => deleteSkillFolder('../../etc', 'project', proj)).toThrow()
  })
})
