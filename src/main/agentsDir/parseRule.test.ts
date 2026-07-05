import { describe, it, expect } from 'vitest'
import { parseRuleFile } from './parseRule'

describe('parseRuleFile', () => {
  it('defaults to always-on with no frontmatter', () => {
    const r = parseRuleFile('style', '# Use tabs\nAlways use tabs.', 'project')
    expect(r).toMatchObject({ name: 'style', activation: 'always', error: undefined })
    expect(r.body).toContain('Always use tabs.')
    expect(r.body).toContain('# Use tabs')
    expect(r.globs).toEqual([])
    expect(r.description).toBe('')
    expect(r.source).toBe('project')
  })

  it('parses an always rule explicitly', () => {
    const raw = '---\nactivation: always\n---\nbody text'
    const r = parseRuleFile('a', raw, 'project')
    expect(r).toMatchObject({ activation: 'always', error: undefined })
    expect(r.body.trim()).toBe('body text')
  })

  it('parses a manual rule', () => {
    const raw = '---\nactivation: manual\n---\nbody text'
    const r = parseRuleFile('m', raw, 'project')
    expect(r).toMatchObject({ activation: 'manual', error: undefined })
  })

  it('parses a model rule with a description', () => {
    const raw = '---\nactivation: model\ndescription: use when writing SQL\n---\nSQL rules here'
    const r = parseRuleFile('sql', raw, 'project')
    expect(r).toMatchObject({
      activation: 'model',
      description: 'use when writing SQL',
      error: undefined
    })
  })

  it('parses a glob rule with inline globs', () => {
    const raw = '---\nactivation: glob\nglobs: [src/**, "*.ts"]\n---\nTS rules here'
    const r = parseRuleFile('ts', raw, 'global')
    expect(r).toMatchObject({
      activation: 'glob',
      globs: ['src/**', '*.ts'],
      source: 'global',
      error: undefined
    })
  })

  it('parses a glob rule with dash-list globs', () => {
    const raw = '---\nactivation: glob\nglobs:\n  - src/**\n  - "*.ts"\n---\nTS rules here'
    const r = parseRuleFile('ts', raw, 'project')
    expect(r).toMatchObject({
      activation: 'glob',
      globs: ['src/**', '*.ts'],
      error: undefined
    })
  })

  it('flags model rules missing a description', () => {
    const r = parseRuleFile('x', '---\nactivation: model\n---\nbody', 'project')
    expect(r.error).toMatch(/description/)
    expect(r.body).toContain('body')
  })

  it('flags glob rules missing globs', () => {
    const r = parseRuleFile('x', '---\nactivation: glob\n---\nbody', 'project')
    expect(r.error).toMatch(/glob/)
    expect(r.body).toContain('body')
  })

  it('flags glob rules with an empty globs list', () => {
    const r = parseRuleFile('x', '---\nactivation: glob\nglobs: []\n---\nbody', 'project')
    expect(r.error).toMatch(/glob/)
  })

  it('flags a bad activation value', () => {
    const r = parseRuleFile('x', '---\nactivation: sometimes\n---\nbody', 'project')
    expect(r.error).toMatch(/activation/)
    expect(r.body).toContain('body')
  })

  it('flags a frontmatter block without a closing ---', () => {
    const r = parseRuleFile('x', '---\nactivation: always\nno closer here', 'project')
    expect(r.error).toBeTruthy()
    // Body is still kept (the whole raw text) so menus can show something.
    expect(r.body).toContain('no closer here')
  })

  it('preserves body exactly, including markdown headers', () => {
    const raw = '---\nactivation: always\n---\n# Title\n\n- one\n- two\n'
    const r = parseRuleFile('x', raw, 'project')
    expect(r.body).toBe('# Title\n\n- one\n- two\n')
  })

  it('parses a CRLF (Windows-edited) glob rule fully', () => {
    const raw = '---\r\nactivation: glob\r\nglobs: [src/**, "*.ts"]\r\n---\r\nTS rules here\r\n'
    const r = parseRuleFile('ts', raw, 'project')
    expect(r).toMatchObject({
      activation: 'glob',
      globs: ['src/**', '*.ts'],
      error: undefined
    })
    // Body output is LF-normalized.
    expect(r.body).toBe('TS rules here\n')
  })

  it('treats an empty frontmatter block as valid defaults', () => {
    const r = parseRuleFile('x', '---\n---\nbody', 'project')
    expect(r).toMatchObject({ activation: 'always', error: undefined })
    expect(r.body).toBe('body')
  })

  it('ignores unknown frontmatter keys', () => {
    const raw = '---\nactivation: always\nfoo: bar\n---\nbody'
    const r = parseRuleFile('x', raw, 'project')
    expect(r.error).toBeUndefined()
    expect(r.activation).toBe('always')
  })
})
