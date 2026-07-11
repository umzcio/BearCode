import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeRuleFile, renderRuleMd } from './index'
import { parseRuleFile } from '../agentsDir/parseRule'

let proj: string
beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'bc-rulew-'))
})
afterEach(() => rmSync(proj, { recursive: true, force: true }))

describe('writeRuleFile (path-jailed)', () => {
  it('writes .agents/rules/<name>.md that parseRuleFile round-trips as an always rule', () => {
    writeRuleFile('team-style', 'Always use tabs.', 'always', 'project', proj)
    const p = join(proj, '.agents', 'rules', 'team-style.md')
    expect(existsSync(p)).toBe(true)
    const parsed = parseRuleFile('team-style', readFileSync(p, 'utf8'), 'project')
    expect(parsed.error).toBeUndefined()
    expect(parsed.activation).toBe('always')
    expect(parsed.body.trim()).toBe('Always use tabs.')
  })
  it('rejects a non-kebab / traversal name', () => {
    expect(() => writeRuleFile('../evil', 'b', 'always', 'project', proj)).toThrow()
    expect(() => writeRuleFile('a/b', 'b', 'always', 'project', proj)).toThrow()
  })
  it('rejects an oversize body (64KB cap)', () => {
    expect(() => writeRuleFile('big', 'x'.repeat(65 * 1024), 'always', 'project', proj)).toThrow(
      /64|size|large/i
    )
  })
  it('project scope with no project path throws', () => {
    expect(() => writeRuleFile('a', 'b', 'always', 'project', null)).toThrow()
  })
  it('renderRuleMd omits a description line for always rules', () => {
    expect(renderRuleMd('body', 'always')).not.toContain('description:')
  })
})
