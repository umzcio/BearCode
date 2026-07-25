// Task 6 (Agent Config Import plan): applyImportSelection ties together the
// scan (Task 2) + translate* (Tasks 3-5) + DB (Task 1) pieces: it writes the
// selected candidates into .agents/{rules,workflows,skills}/ with
// collision-safe naming (never overwrite an existing file) and records each
// import in the imported_config_sources table.
//
// better-sqlite3's native binding can't load under plain-Node vitest, so
// 'electron' and 'better-sqlite3' are mocked at module level, following the
// precedent in db/importedConfig.test.ts: a FakeDatabase that regex-matches
// the SQL passed to prepare() against an in-memory Map.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dbTestDir = mkdtempSync(join(tmpdir(), 'bearcode-importer-db-'))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => dbTestDir) }
}))

type Row = Record<string, unknown>
// Keyed by `${project_path}::${source_path}` -- the table's real uniqueness is
// on that pair, not a single path.
const store = new Map<string, Row>()

vi.mock('better-sqlite3', () => ({
  default: vi.fn().mockImplementation(function FakeDatabase() {
    return {
      pragma: vi.fn(),
      exec: vi.fn(),
      prepare: vi.fn((sql: string) => ({
        run: (...args: unknown[]) => {
          if (/INSERT OR IGNORE INTO imported_config_sources/.test(sql)) {
            const [id, projectPath, sourcePath, status, createdAt] = args as [
              string,
              string,
              string,
              string,
              number
            ]
            const key = `${projectPath}::${sourcePath}`
            if (!store.has(key)) {
              store.set(key, {
                id,
                project_path: projectPath,
                source_path: sourcePath,
                source_hash: null,
                imported_as_type: null,
                imported_as_name: null,
                status,
                dismissed_at: null,
                created_at: createdAt
              })
            }
          } else if (/UPDATE imported_config_sources SET/.test(sql)) {
            const setPart = /SET (.+) WHERE/.exec(sql)?.[1] ?? ''
            const cols = setPart.split(',').map((c) => c.trim().split('=')[0].trim())
            const projectPath = args[args.length - 2] as string
            const sourcePath = args[args.length - 1] as string
            const key = `${projectPath}::${sourcePath}`
            const row = store.get(key) ?? { project_path: projectPath, source_path: sourcePath }
            cols.forEach((col, i) => {
              row[col] = args[i]
            })
            store.set(key, row)
          }
        },
        get: (...args: unknown[]) => {
          if (/WHERE project_path = \? AND source_path = \?/.test(sql)) {
            const [projectPath, sourcePath] = args as [string, string]
            return store.get(`${projectPath}::${sourcePath}`)
          }
          return undefined
        },
        all: () => []
      }))
    }
  })
}))

import { applyImportSelection } from './importer'
import { getImportedConfig } from '../db'

describe('applyImportSelection', () => {
  let dir: string
  beforeEach(() => {
    store.clear()
    dir = mkdtempSync(join(tmpdir(), 'bearcode-importer-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writes an imported rule file and records it', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'Always use tabs.')
    const summary = applyImportSelection(dir, { rules: ['CLAUDE.md'], workflows: [], skills: [] })
    expect(summary).toEqual({ rulesImported: 1, workflowsImported: 0, skillsImported: 0 })
    const written = readFileSync(join(dir, '.agents', 'rules', 'claude.md'), 'utf8')
    expect(written).toBe('Always use tabs.')
    const row = getImportedConfig(dir, 'CLAUDE.md')
    expect(row).toMatchObject({ importedAsType: 'rule', importedAsName: 'claude', status: 'imported' })
  })

  it('suffixes the name on a collision instead of overwriting', () => {
    mkdirSync(join(dir, '.agents', 'rules'), { recursive: true })
    writeFileSync(join(dir, '.agents', 'rules', 'claude.md'), 'existing rule, do not touch')
    writeFileSync(join(dir, 'CLAUDE.md'), 'new content')
    applyImportSelection(dir, { rules: ['CLAUDE.md'], workflows: [], skills: [] })
    expect(readFileSync(join(dir, '.agents', 'rules', 'claude.md'), 'utf8')).toBe(
      'existing rule, do not touch'
    )
    expect(readFileSync(join(dir, '.agents', 'rules', 'claude-imported.md'), 'utf8')).toBe(
      'new content'
    )
  })

  it('copies a skill folder verbatim', () => {
    mkdirSync(join(dir, '.claude', 'skills', 'pdf-export'), { recursive: true })
    writeFileSync(
      join(dir, '.claude', 'skills', 'pdf-export', 'SKILL.md'),
      '---\ndescription: Export docs to PDF\n---\nBody.'
    )
    const summary = applyImportSelection(dir, {
      rules: [],
      workflows: [],
      skills: [join('.claude', 'skills', 'pdf-export')]
    })
    expect(summary.skillsImported).toBe(1)
    expect(existsSync(join(dir, '.agents', 'skills', 'pdf-export', 'SKILL.md'))).toBe(true)
    const row = getImportedConfig(dir, join('.claude', 'skills', 'pdf-export'))
    expect(row).toMatchObject({
      importedAsType: 'skill',
      importedAsName: 'pdf-export',
      status: 'imported'
    })
  })

  it('suffixes the skill folder name on a collision instead of overwriting', () => {
    mkdirSync(join(dir, '.claude', 'skills', 'pdf-export'), { recursive: true })
    writeFileSync(
      join(dir, '.claude', 'skills', 'pdf-export', 'SKILL.md'),
      '---\ndescription: Export docs to PDF\n---\nBody.'
    )
    mkdirSync(join(dir, '.agents', 'skills', 'pdf-export'), { recursive: true })
    writeFileSync(
      join(dir, '.agents', 'skills', 'pdf-export', 'SKILL.md'),
      'existing skill, do not touch'
    )
    const summary = applyImportSelection(dir, {
      rules: [],
      workflows: [],
      skills: [join('.claude', 'skills', 'pdf-export')]
    })
    expect(summary.skillsImported).toBe(1)
    expect(readFileSync(join(dir, '.agents', 'skills', 'pdf-export', 'SKILL.md'), 'utf8')).toBe(
      'existing skill, do not touch'
    )
    expect(
      existsSync(join(dir, '.agents', 'skills', 'pdf-export-imported', 'SKILL.md'))
    ).toBe(true)
  })

  it('skips a selection whose candidate no longer builds (e.g. file deleted)', () => {
    const summary = applyImportSelection(dir, { rules: ['GONE.md'], workflows: [], skills: [] })
    expect(summary.rulesImported).toBe(0)
  })

  it('imports a workflow candidate and records it', () => {
    mkdirSync(join(dir, '.claude', 'commands'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'commands', 'deploy.md'), 'Deploy the app.')
    const summary = applyImportSelection(dir, {
      rules: [],
      workflows: [join('.claude', 'commands', 'deploy.md')],
      skills: []
    })
    expect(summary.workflowsImported).toBe(1)
    expect(readFileSync(join(dir, '.agents', 'workflows', 'deploy.md'), 'utf8')).toBe(
      'Deploy the app.'
    )
    const row = getImportedConfig(dir, join('.claude', 'commands', 'deploy.md'))
    expect(row).toMatchObject({
      importedAsType: 'workflow',
      importedAsName: 'deploy',
      status: 'imported'
    })
  })
})
