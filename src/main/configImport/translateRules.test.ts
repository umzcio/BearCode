import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildRuleCandidate } from './translateRules'

describe('buildRuleCandidate', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bearcode-import-rules-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('derives a kebab-case name from the source filename', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'Always use tabs.')
    const c = buildRuleCandidate(dir, { sourcePath: 'CLAUDE.md', kind: 'rule', tool: 'claude-code' })
    expect(c).toMatchObject({ sourcePath: 'CLAUDE.md', suggestedName: 'claude', body: 'Always use tabs.' })
  })

  it('derives a name for a nested rule file', () => {
    mkdirSync(join(dir, '.cursor', 'rules'), { recursive: true })
    writeFileSync(join(dir, '.cursor', 'rules', 'testing.md'), 'Use vitest.')
    const c = buildRuleCandidate(dir, {
      sourcePath: join('.cursor', 'rules', 'testing.md'),
      kind: 'rule',
      tool: 'cursor'
    })
    expect(c?.suggestedName).toBe('testing')
  })

  it('resolves @path references using the shared rule-ref resolver', () => {
    writeFileSync(join(dir, 'shared.md'), 'Shared conventions.')
    writeFileSync(join(dir, 'CLAUDE.md'), 'See @shared.md for conventions.')
    const c = buildRuleCandidate(dir, { sourcePath: 'CLAUDE.md', kind: 'rule', tool: 'claude-code' })
    expect(c?.body).toContain('Shared conventions.')
    expect(c?.warnings).toEqual([])
  })

  it('returns null for a missing file', () => {
    const c = buildRuleCandidate(dir, { sourcePath: 'MISSING.md', kind: 'rule', tool: 'claude-code' })
    expect(c).toBeNull()
  })

  it('returns null for an empty/whitespace-only file', () => {
    writeFileSync(join(dir, 'AGENTS.md'), '   \n  ')
    const c = buildRuleCandidate(dir, { sourcePath: 'AGENTS.md', kind: 'rule', tool: 'codex' })
    expect(c).toBeNull()
  })
})
