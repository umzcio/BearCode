import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { scanImportableConfig, shouldShowImportBanner } from './scan'

describe('scanImportableConfig', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bearcode-import-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('finds nothing in an empty project', () => {
    expect(scanImportableConfig(dir)).toEqual([])
  })

  it('detects CLAUDE.md, AGENTS.md, .cursorrules, .windsurfrules', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'x')
    writeFileSync(join(dir, 'AGENTS.md'), 'x')
    writeFileSync(join(dir, '.cursorrules'), 'x')
    writeFileSync(join(dir, '.windsurfrules'), 'x')
    const found = scanImportableConfig(dir)
    expect(found).toEqual(
      expect.arrayContaining([
        { sourcePath: 'CLAUDE.md', kind: 'rule', tool: 'claude-code' },
        { sourcePath: 'AGENTS.md', kind: 'rule', tool: 'codex' },
        { sourcePath: '.cursorrules', kind: 'rule', tool: 'cursor' },
        { sourcePath: '.windsurfrules', kind: 'rule', tool: 'windsurf' }
      ])
    )
  })

  it('detects .cursor/rules/*.md and .windsurf/rules/*.md', () => {
    mkdirSync(join(dir, '.cursor', 'rules'), { recursive: true })
    writeFileSync(join(dir, '.cursor', 'rules', 'testing.md'), 'x')
    mkdirSync(join(dir, '.windsurf', 'rules'), { recursive: true })
    writeFileSync(join(dir, '.windsurf', 'rules', 'style.md'), 'x')
    const found = scanImportableConfig(dir)
    expect(found).toContainEqual({
      sourcePath: join('.cursor', 'rules', 'testing.md'),
      kind: 'rule',
      tool: 'cursor'
    })
    expect(found).toContainEqual({
      sourcePath: join('.windsurf', 'rules', 'style.md'),
      kind: 'rule',
      tool: 'windsurf'
    })
  })

  it('detects .claude/commands/*.md as workflows', () => {
    mkdirSync(join(dir, '.claude', 'commands'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'commands', 'deploy.md'), 'x')
    const found = scanImportableConfig(dir)
    expect(found).toContainEqual({
      sourcePath: join('.claude', 'commands', 'deploy.md'),
      kind: 'workflow',
      tool: 'claude-code'
    })
  })

  it('detects .claude/skills/<name>/SKILL.md folders as skills', () => {
    mkdirSync(join(dir, '.claude', 'skills', 'pdf-export'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'skills', 'pdf-export', 'SKILL.md'), 'x')
    mkdirSync(join(dir, '.claude', 'skills', 'no-skill-md'), { recursive: true })
    const found = scanImportableConfig(dir)
    expect(found).toContainEqual({
      sourcePath: join('.claude', 'skills', 'pdf-export'),
      kind: 'skill',
      tool: 'claude-code'
    })
    expect(found.some((f) => f.sourcePath.includes('no-skill-md'))).toBe(false)
  })

  it('detects .claude/agents/*.md as unsupported', () => {
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'agents', 'reviewer.md'), 'x')
    const found = scanImportableConfig(dir)
    expect(found).toContainEqual({
      sourcePath: join('.claude', 'agents', 'reviewer.md'),
      kind: 'unsupported',
      tool: 'claude-code'
    })
  })
})

describe('shouldShowImportBanner', () => {
  const detected = [{ sourcePath: 'CLAUDE.md', kind: 'rule' as const, tool: 'claude-code' as const }]

  it('shows the banner when a source was never seen before', () => {
    expect(shouldShowImportBanner(detected, [], 1000)).toBe(true)
  })

  it('does not show the banner for an already-imported source', () => {
    const known = [
      {
        id: '1',
        projectPath: '/p',
        sourcePath: 'CLAUDE.md',
        sourceHash: 'h',
        importedAsType: 'rule' as const,
        importedAsName: 'claude-md',
        status: 'imported' as const,
        dismissedAt: null,
        createdAt: 0
      }
    ]
    expect(shouldShowImportBanner(detected, known, 1000)).toBe(false)
  })

  it('does not show the banner within 7 days of a dismissal', () => {
    const oneDayMs = 24 * 60 * 60 * 1000
    const known = [
      {
        id: '1',
        projectPath: '/p',
        sourcePath: 'CLAUDE.md',
        sourceHash: null,
        importedAsType: null,
        importedAsName: null,
        status: 'dismissed' as const,
        dismissedAt: 1000,
        createdAt: 1000
      }
    ]
    expect(shouldShowImportBanner(detected, known, 1000 + oneDayMs)).toBe(false)
  })

  it('re-shows the banner after 7 days past a dismissal', () => {
    const eightDaysMs = 8 * 24 * 60 * 60 * 1000
    const known = [
      {
        id: '1',
        projectPath: '/p',
        sourcePath: 'CLAUDE.md',
        sourceHash: null,
        importedAsType: null,
        importedAsName: null,
        status: 'dismissed' as const,
        dismissedAt: 1000,
        createdAt: 1000
      }
    ]
    expect(shouldShowImportBanner(detected, known, 1000 + eightDaysMs)).toBe(true)
  })
})
