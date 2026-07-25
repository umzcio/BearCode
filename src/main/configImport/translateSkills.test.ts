import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildSkillCandidate } from './translateSkills'

describe('buildSkillCandidate', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bearcode-import-skills-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('returns a candidate for a valid SKILL.md', () => {
    mkdirSync(join(dir, '.claude', 'skills', 'pdf-export'), { recursive: true })
    writeFileSync(
      join(dir, '.claude', 'skills', 'pdf-export', 'SKILL.md'),
      '---\ndescription: Export docs to PDF\n---\nBody text.'
    )
    const c = buildSkillCandidate(dir, {
      sourcePath: join('.claude', 'skills', 'pdf-export'),
      kind: 'skill',
      tool: 'claude-code'
    })
    expect(c).toMatchObject({
      sourcePath: join('.claude', 'skills', 'pdf-export'),
      suggestedName: 'pdf-export',
      description: 'Export docs to PDF'
    })
  })

  it('returns null when SKILL.md is missing a required description', () => {
    mkdirSync(join(dir, '.claude', 'skills', 'broken'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'skills', 'broken', 'SKILL.md'), 'no frontmatter at all')
    const c = buildSkillCandidate(dir, {
      sourcePath: join('.claude', 'skills', 'broken'),
      kind: 'skill',
      tool: 'claude-code'
    })
    expect(c).toBeNull()
  })

  it('returns null when SKILL.md is missing entirely', () => {
    mkdirSync(join(dir, '.claude', 'skills', 'empty-dir'), { recursive: true })
    const c = buildSkillCandidate(dir, {
      sourcePath: join('.claude', 'skills', 'empty-dir'),
      kind: 'skill',
      tool: 'claude-code'
    })
    expect(c).toBeNull()
  })
})
