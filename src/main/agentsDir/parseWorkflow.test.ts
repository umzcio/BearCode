import { describe, it, expect } from 'vitest'
import { parseWorkflowFile } from './parseWorkflow'

describe('parseWorkflowFile', () => {
  it('defaults to an empty description with no frontmatter, body preserved', () => {
    const w = parseWorkflowFile('release-check', '# Release check\nDo the thing.', 'project')
    expect(w).toMatchObject({ name: 'release-check', description: '', error: undefined })
    expect(w.body).toContain('# Release check')
    expect(w.body).toContain('Do the thing.')
    expect(w.source).toBe('project')
  })

  it('honors a bare frontmatter description', () => {
    const raw = '---\ndescription: Run the release checklist\n---\n1. Step one'
    const w = parseWorkflowFile('release-check', raw, 'project')
    expect(w).toMatchObject({ description: 'Run the release checklist', error: undefined })
  })

  it('honors a quoted frontmatter description', () => {
    const raw = '---\ndescription: "Run the release checklist"\n---\n1. Step one'
    const w = parseWorkflowFile('release-check', raw, 'global')
    expect(w).toMatchObject({
      description: 'Run the release checklist',
      source: 'global',
      error: undefined
    })
  })

  it('flags an unclosed frontmatter block, body preserved', () => {
    const raw = '---\ndescription: broken\nno closer here'
    const w = parseWorkflowFile('broken', raw, 'project')
    expect(w.error).toBeTruthy()
    expect(w.body).toContain('no closer here')
  })

  it('extracts numbered steps in order, with continuation lines attached', () => {
    const raw = [
      '1. First step',
      '   more detail for first',
      '2. Second step',
      '3. Third step'
    ].join('\n')
    const w = parseWorkflowFile('numbered', raw, 'project')
    expect(w.steps).toEqual(['First step\nmore detail for first', 'Second step', 'Third step'])
  })

  it('extracts steps from a "1)" numbered form', () => {
    const raw = '1) First\n2) Second'
    const w = parseWorkflowFile('paren-numbered', raw, 'project')
    expect(w.steps).toEqual(['First', 'Second'])
  })

  it('extracts dashed steps', () => {
    const raw = '- First\n- Second\n- Third'
    const w = parseWorkflowFile('dashed', raw, 'project')
    expect(w.steps).toEqual(['First', 'Second', 'Third'])
  })

  it('extracts dashed steps written with *', () => {
    const raw = '* First\n* Second'
    const w = parseWorkflowFile('star-dashed', raw, 'project')
    expect(w.steps).toEqual(['First', 'Second'])
  })

  it('treats a prose-only body as one step equal to the trimmed body', () => {
    const raw = '# Title\n\nJust some prose, no list here.\n'
    const w = parseWorkflowFile('prose', raw, 'project')
    expect(w.steps).toEqual(['# Title\n\nJust some prose, no list here.'])
  })

  it('only turns list items into steps when prose precedes the list', () => {
    const raw = 'Some intro text before the list.\n\n1. Do this\n2. Do that'
    const w = parseWorkflowFile('prose-plus-list', raw, 'project')
    expect(w.steps).toEqual(['Do this', 'Do that'])
    expect(w.body).toContain('Some intro text before the list.')
  })

  it('normalizes CRLF line endings', () => {
    const raw = '---\r\ndescription: crlf test\r\n---\r\n1. First\r\n2. Second\r\n'
    const w = parseWorkflowFile('crlf', raw, 'project')
    expect(w).toMatchObject({ description: 'crlf test', error: undefined })
    expect(w.steps).toEqual(['First', 'Second'])
    expect(w.body).not.toContain('\r')
  })

  it('flags an empty file with steps: [] and no fabricated step', () => {
    const w = parseWorkflowFile('empty', '', 'project')
    expect(w.steps).toEqual([])
    expect(w.error).toBe('workflow file is empty')
  })

  it('flags a filename that is not kebab-case as a greyed error entry', () => {
    const w = parseWorkflowFile('My_Workflow', '1. Do a thing', 'project')
    expect(w.error).toBe('workflow filename must be kebab-case (lowercase letters, digits, dashes)')
  })

  it('flags a non-ascii filename as a greyed error entry', () => {
    const w = parseWorkflowFile('café', '1. Do a thing', 'project')
    expect(w.error).toBe('workflow filename must be kebab-case (lowercase letters, digits, dashes)')
  })

  it('accepts a valid kebab-case filename', () => {
    const w = parseWorkflowFile('release-check-2', '1. Do a thing', 'project')
    expect(w.error).toBeUndefined()
  })
})
