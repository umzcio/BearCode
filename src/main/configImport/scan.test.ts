import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { scanImportableConfig, shouldShowImportBanner } from './scan'

describe('scanImportableConfig', () => {
  let dir: string
  let outsideDir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bearcode-import-'))
    outsideDir = mkdtempSync(join(tmpdir(), 'bearcode-import-outside-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  })

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

  // Final review Finding 8: Cursor's real modern project-rules format is
  // `.cursor/rules/*.mdc` (MDC frontmatter), and `.md` there is the unusual
  // case -- filtering on `.md` alone found nothing for real Cursor users.
  it('detects .cursor/rules/*.mdc and .windsurf/rules/*.mdc', () => {
    mkdirSync(join(dir, '.cursor', 'rules'), { recursive: true })
    writeFileSync(join(dir, '.cursor', 'rules', 'testing.mdc'), 'x')
    mkdirSync(join(dir, '.windsurf', 'rules'), { recursive: true })
    writeFileSync(join(dir, '.windsurf', 'rules', 'style.mdc'), 'x')
    const found = scanImportableConfig(dir)
    expect(found).toContainEqual({
      sourcePath: join('.cursor', 'rules', 'testing.mdc'),
      kind: 'rule',
      tool: 'cursor'
    })
    expect(found).toContainEqual({
      sourcePath: join('.windsurf', 'rules', 'style.mdc'),
      kind: 'rule',
      tool: 'windsurf'
    })
  })

  it('ignores unrelated extensions in a rules directory', () => {
    mkdirSync(join(dir, '.cursor', 'rules'), { recursive: true })
    writeFileSync(join(dir, '.cursor', 'rules', 'notes.txt'), 'x')
    writeFileSync(join(dir, '.cursor', 'rules', 'config.json'), '{}')
    expect(scanImportableConfig(dir)).toEqual([])
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

  // Security: a symlinked CLAUDE.md pointing outside the project must never
  // be detected -- following it would stat/read an arbitrary locally
  // readable file and surface its content in the import preview.
  it('does not detect a symlinked CLAUDE.md pointing outside the project', () => {
    const outsideFile = join(outsideDir, 'secret.md')
    writeFileSync(outsideFile, 'secret content')
    symlinkSync(outsideFile, join(dir, 'CLAUDE.md'))
    expect(scanImportableConfig(dir)).toEqual([])
  })

  // Security: same as above but for a rules-directory entry, and proves the
  // symlink filter is selective (a sibling real .md file is still detected).
  it('excludes a symlinked file in .cursor/rules/ while still detecting a normal one', () => {
    mkdirSync(join(dir, '.cursor', 'rules'), { recursive: true })
    const outsideFile = join(outsideDir, 'evil.md')
    writeFileSync(outsideFile, 'evil content')
    symlinkSync(outsideFile, join(dir, '.cursor', 'rules', 'evil.md'))
    writeFileSync(join(dir, '.cursor', 'rules', 'real.md'), 'real content')
    const found = scanImportableConfig(dir)
    expect(found.some((f) => f.sourcePath.includes('evil.md'))).toBe(false)
    expect(found).toContainEqual({
      sourcePath: join('.cursor', 'rules', 'real.md'),
      kind: 'rule',
      tool: 'cursor'
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

  // Final review Finding 2: the renderer's dismissImportBanner only dismisses
  // kind !== 'unsupported' paths, so an 'unsupported' source could never get a
  // `dismissed` DB row. Counting it here made the banner reappear on every
  // folder open, forever, with no way to silence it via "Not now".
  it('never shows the banner for a project with ONLY an unsupported source', () => {
    const unsupportedOnly = [
      { sourcePath: '.claude/agents/reviewer.md', kind: 'unsupported' as const, tool: 'claude-code' as const }
    ]
    expect(shouldShowImportBanner(unsupportedOnly, [], 1000)).toBe(false)
  })

  it('still shows the banner when an importable source sits alongside an unsupported one', () => {
    const mixed = [
      { sourcePath: '.claude/agents/reviewer.md', kind: 'unsupported' as const, tool: 'claude-code' as const },
      ...detected
    ]
    expect(shouldShowImportBanner(mixed, [], 1000)).toBe(true)
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
