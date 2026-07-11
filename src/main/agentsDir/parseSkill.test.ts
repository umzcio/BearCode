import { describe, it, expect } from 'vitest'
import { parseSkillFolder } from './parseSkill'

describe('parseSkillFolder', () => {
  it('parses name + description + body from frontmatter', () => {
    const raw = '---\nname: pdf-extract\ndescription: Extract text from PDFs.\n---\n\nBody here.\n'
    const s = parseSkillFolder('pdf-extract', raw, 'project')
    expect(s.error).toBeUndefined()
    expect(s.name).toBe('pdf-extract')
    expect(s.description).toBe('Extract text from PDFs.')
    expect(s.body.trim()).toBe('Body here.')
    expect(s.source).toBe('project')
  })

  it('defaults name to the folder name when frontmatter omits it', () => {
    const raw = '---\ndescription: Do a thing.\n---\nbody'
    expect(parseSkillFolder('my-skill', raw, 'global').name).toBe('my-skill')
  })

  it('frontmatter name overrides the folder name', () => {
    const raw = '---\nname: real-name\ndescription: x\n---\nbody'
    expect(parseSkillFolder('folder-name', raw, 'project').name).toBe('real-name')
  })

  it('errors when description is missing (never offered to the model)', () => {
    const raw = '---\nname: no-desc\n---\nbody'
    const s = parseSkillFolder('no-desc', raw, 'project')
    expect(s.error).toMatch(/description/i)
  })

  it('errors when description is present but blank', () => {
    const raw = '---\nname: blank\ndescription:   \n---\nbody'
    expect(parseSkillFolder('blank', raw, 'project').error).toMatch(/description/i)
  })

  it('errors on a non-kebab effective name', () => {
    const raw = '---\nname: Bad_Name\ndescription: x\n---\nbody'
    expect(parseSkillFolder('whatever', raw, 'project').error).toMatch(/kebab/i)
  })

  it('preserves a malformed-frontmatter error from parseFrontmatter', () => {
    const raw = '---\ndescription: x\nbody with no closer'
    expect(parseSkillFolder('x', raw, 'project').error).toBeTruthy()
  })

  it('normalizes CRLF to LF', () => {
    const raw = '---\r\ndescription: x\r\n---\r\nline1\r\nline2\r\n'
    expect(parseSkillFolder('x', raw, 'project').body).not.toMatch(/\r/)
  })
})
