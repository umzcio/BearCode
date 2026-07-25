// Task 7 (Agent Config Import plan): checkSourceForUpdate/applySourceUpdate/
// ignoreSourceUpdate/detachSource/dismissDetectedSources sit on top of the
// Task 6 importer (applyImportSelection) + Task 1 DB + Task 3/4 translators.
//
// Same mocking precedent as importer.test.ts: better-sqlite3's native binding
// can't load under plain-Node vitest, so 'electron' and 'better-sqlite3' are
// mocked at module level with a FakeDatabase that regex-matches the SQL
// passed to prepare() against an in-memory Map.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dbTestDir = mkdtempSync(join(tmpdir(), 'bearcode-checkupdate-db-'))

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
          } else if (/DELETE FROM imported_config_sources/.test(sql)) {
            const [projectPath, sourcePath] = args as [string, string]
            store.delete(`${projectPath}::${sourcePath}`)
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
import {
  checkSourceForUpdate,
  applySourceUpdate,
  ignoreSourceUpdate,
  detachSource,
  dismissDetectedSources
} from './checkUpdates'
import { getImportedConfig, upsertImportedConfig } from '../db'

describe('checkSourceForUpdate', () => {
  let dir: string
  beforeEach(() => {
    store.clear()
    dir = mkdtempSync(join(tmpdir(), 'bearcode-checkupdate-'))
    writeFileSync(join(dir, 'CLAUDE.md'), 'Original content.')
    applyImportSelection(dir, { rules: ['CLAUDE.md'], workflows: [], skills: [] })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reports up-to-date when the source is unchanged', () => {
    expect(checkSourceForUpdate(dir, 'CLAUDE.md')).toEqual({ state: 'up-to-date' })
  })

  it('reports a diff when the source changed', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'Updated content.')
    const result = checkSourceForUpdate(dir, 'CLAUDE.md')
    expect(result).toMatchObject({ state: 'changed', newBody: 'Updated content.' })
  })

  it('reports source-missing when the file was deleted', () => {
    rmSync(join(dir, 'CLAUDE.md'))
    expect(checkSourceForUpdate(dir, 'CLAUDE.md')).toEqual({ state: 'source-missing' })
  })

  it('applySourceUpdate overwrites the imported rule with the new content', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'Updated content.')
    applySourceUpdate(dir, 'CLAUDE.md')
    expect(readFileSync(join(dir, '.agents', 'rules', 'claude.md'), 'utf8')).toBe('Updated content.')
    expect(checkSourceForUpdate(dir, 'CLAUDE.md')).toEqual({ state: 'up-to-date' })
  })

  it('ignoreSourceUpdate stops flagging the same change as new', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'Updated content.')
    ignoreSourceUpdate(dir, 'CLAUDE.md')
    expect(checkSourceForUpdate(dir, 'CLAUDE.md')).toEqual({ state: 'up-to-date' })
    expect(readFileSync(join(dir, '.agents', 'rules', 'claude.md'), 'utf8')).toBe('Original content.')
  })

  it('ignoreSourceUpdate is a silent no-op when the source file no longer exists', () => {
    const before = getImportedConfig(dir, 'CLAUDE.md')
    rmSync(join(dir, 'CLAUDE.md'))
    expect(() => ignoreSourceUpdate(dir, 'CLAUDE.md')).not.toThrow()
    const after = getImportedConfig(dir, 'CLAUDE.md')
    expect(after?.sourceHash).toBe(before?.sourceHash)
  })

  it('detachSource removes the tracking row without touching the imported file', () => {
    detachSource(dir, 'CLAUDE.md')
    expect(getImportedConfig(dir, 'CLAUDE.md')).toBeNull()
    expect(readFileSync(join(dir, '.agents', 'rules', 'claude.md'), 'utf8')).toBe('Original content.')
  })

  it('does not throw when an mcp-typed row is passed to checkSourceForUpdate', () => {
    // Task 1 extended ImportedConfigRow.importedAsType to include 'mcp', which
    // made the importedDirFor switch exhaustive (compile-time protection via
    // TypeScript noImplicitReturns). This test verifies the 'mcp' case was added
    // to the switch statement (RED→GREEN proof). Realistic MCP rows have synthetic
    // sourcePaths (e.g. '.claude/settings.json#filesystem') that don't exist on
    // disk, so checkSourceForUpdate returns 'source-missing' early; the switch is
    // compile-time-only protected (runtime, import-once MCPs never reach that code).
    const mcpDir = mkdtempSync(join(tmpdir(), 'bearcode-mcp-checkupdate-'))
    upsertImportedConfig(mcpDir, '.claude/settings.json#filesystem', {
      importedAsType: 'mcp',
      importedAsName: 'filesystem',
      status: 'imported',
      createdAt: Date.now()
    })
    expect(() => checkSourceForUpdate(mcpDir, '.claude/settings.json#filesystem')).not.toThrow()
    rmSync(mcpDir, { recursive: true, force: true })
  })
})

// Final review Finding 5: a SKILL row's sourcePath is a DIRECTORY, and both
// checkSourceForUpdate and ignoreSourceUpdate used to hash it with a raw
// readFileSync(abs, 'utf8') -- which throws EISDIR, breaking the never-throw
// contract through the shipped config-import:check-update / :ignore-update IPC
// handlers. Hashing now resolves a folder source to its SKILL.md via the capped
// reader. This entity kind previously had zero coverage here.
describe('checkSourceForUpdate for a skill source (directory sourcePath)', () => {
  let dir: string
  const sp = join('.claude', 'skills', 'pdf-export')
  const skillMd = (): string => join(dir, sp, 'SKILL.md')

  beforeEach(() => {
    store.clear()
    dir = mkdtempSync(join(tmpdir(), 'bearcode-checkupdate-skill-'))
    mkdirSync(join(dir, sp), { recursive: true })
    writeFileSync(skillMd(), '---\ndescription: Export docs to PDF\n---\nBody.')
    applyImportSelection(dir, { rules: [], workflows: [], skills: [sp] })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reports up-to-date instead of throwing EISDIR when unchanged', () => {
    expect(() => checkSourceForUpdate(dir, sp)).not.toThrow()
    expect(checkSourceForUpdate(dir, sp)).toEqual({ state: 'up-to-date' })
  })

  it('does not throw (and offers no text diff) after SKILL.md changes', () => {
    writeFileSync(skillMd(), '---\ndescription: Export docs to PDF\n---\nRewritten body.')
    expect(() => checkSourceForUpdate(dir, sp)).not.toThrow()
    // Skill folders are out of scope for the text-diff flow, so a changed
    // SKILL.md is reported as up-to-date rather than as a bogus rule/workflow
    // diff -- and critically, never as a thrown error.
    expect(checkSourceForUpdate(dir, sp)).toEqual({ state: 'up-to-date' })
  })

  it('applySourceUpdate is a no-op for a skill row and never throws', () => {
    writeFileSync(skillMd(), '---\ndescription: Export docs to PDF\n---\nRewritten body.')
    expect(() => applySourceUpdate(dir, sp)).not.toThrow()
    // Nothing written into .agents/workflows/ (the old ternary's silent
    // misroute target) and the copied folder is left alone.
    expect(existsSync(join(dir, '.agents', 'workflows'))).toBe(false)
    expect(readFileSync(join(dir, '.agents', 'skills', 'pdf-export', 'SKILL.md'), 'utf8')).toBe(
      '---\ndescription: Export docs to PDF\n---\nBody.'
    )
  })

  it('ignoreSourceUpdate re-baselines the hash off SKILL.md without throwing', () => {
    const before = getImportedConfig(dir, sp)?.sourceHash
    writeFileSync(skillMd(), '---\ndescription: Export docs to PDF\n---\nRewritten body.')
    expect(() => ignoreSourceUpdate(dir, sp)).not.toThrow()
    const after = getImportedConfig(dir, sp)?.sourceHash
    expect(after).toBeTruthy()
    expect(after).not.toBe(before)
  })

  it('reports source-missing when the skill folder was deleted', () => {
    rmSync(join(dir, sp), { recursive: true, force: true })
    expect(checkSourceForUpdate(dir, sp)).toEqual({ state: 'source-missing' })
  })

  it('reports source-missing when the folder survives but SKILL.md is gone', () => {
    rmSync(skillMd())
    expect(checkSourceForUpdate(dir, sp)).toEqual({ state: 'source-missing' })
  })
})

describe('applySourceUpdate resilience', () => {
  it('recreates .agents/rules/ if it was deleted by hand since the import', () => {
    store.clear()
    const dir = mkdtempSync(join(tmpdir(), 'bearcode-checkupdate-mkdir-'))
    writeFileSync(join(dir, 'CLAUDE.md'), 'Original content.')
    applyImportSelection(dir, { rules: ['CLAUDE.md'], workflows: [], skills: [] })
    rmSync(join(dir, '.agents'), { recursive: true, force: true })
    writeFileSync(join(dir, 'CLAUDE.md'), 'Updated content.')
    expect(() => applySourceUpdate(dir, 'CLAUDE.md')).not.toThrow()
    expect(readFileSync(join(dir, '.agents', 'rules', 'claude.md'), 'utf8')).toBe('Updated content.')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('dismissDetectedSources', () => {
  it('marks each source dismissed with the current timestamp', () => {
    store.clear()
    const dir = mkdtempSync(join(tmpdir(), 'bearcode-dismiss-'))
    writeFileSync(join(dir, 'AGENTS.md'), 'x')
    dismissDetectedSources(dir, ['AGENTS.md'])
    const row = getImportedConfig(dir, 'AGENTS.md')
    expect(row?.status).toBe('dismissed')
    expect(row?.dismissedAt).not.toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })
})
