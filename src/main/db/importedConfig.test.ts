// Task 1 (Agent Config Import plan): imported_config_sources tracks which
// external config files (CLAUDE.md, AGENTS.md, .cursorrules, ...) have been
// imported/dismissed per project. better-sqlite3's native binding can't load
// under plain-Node vitest, so 'electron' and 'better-sqlite3' are mocked at
// module level, following the precedent in projectTrust.test.ts: a FakeDatabase
// that regex-matches the SQL passed to prepare() against an in-memory Map.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const testDir = mkdtempSync(join(tmpdir(), 'bearcode-test-'))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => testDir) }
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
        all: (...args: unknown[]) => {
          if (/WHERE project_path = \?/.test(sql) && !/source_path/.test(sql)) {
            const [projectPath] = args as [string]
            return Array.from(store.values()).filter((r) => r.project_path === projectPath)
          }
          return []
        }
      }))
    }
  })
}))

import { upsertImportedConfig, listImportedConfig, getImportedConfig, deleteImportedConfig } from './index'

beforeEach(() => store.clear())

describe('imported_config_sources', () => {
  const proj = '/tmp/test-project'

  it('upserts and reads back a row', () => {
    upsertImportedConfig(proj, 'CLAUDE.md', {
      sourceHash: 'abc123',
      importedAsType: 'rule',
      importedAsName: 'claude-md',
      status: 'imported',
      createdAt: 1000
    })
    const row = getImportedConfig(proj, 'CLAUDE.md')
    expect(row).toMatchObject({
      projectPath: proj,
      sourcePath: 'CLAUDE.md',
      sourceHash: 'abc123',
      importedAsType: 'rule',
      importedAsName: 'claude-md',
      status: 'imported'
    })
  })

  it('updates only the patched columns on a second upsert', () => {
    upsertImportedConfig(proj, 'AGENTS.md', {
      sourceHash: 'h1',
      status: 'imported',
      importedAsType: 'rule',
      importedAsName: 'agents-md',
      createdAt: 2000
    })
    upsertImportedConfig(proj, 'AGENTS.md', { sourceHash: 'h2' })
    const row = getImportedConfig(proj, 'AGENTS.md')
    expect(row?.sourceHash).toBe('h2')
    expect(row?.importedAsName).toBe('agents-md')
  })

  it('lists all rows for a project', () => {
    upsertImportedConfig(proj, 'CLAUDE.md', { status: 'imported', createdAt: 1000 })
    upsertImportedConfig(proj, 'AGENTS.md', { status: 'imported', createdAt: 2000 })
    upsertImportedConfig(proj, '.cursorrules', { status: 'dismissed', dismissedAt: 5000, createdAt: 5000 })
    const rows = listImportedConfig(proj)
    expect(rows.map((r) => r.sourcePath)).toEqual(
      expect.arrayContaining(['CLAUDE.md', 'AGENTS.md', '.cursorrules'])
    )
  })

  it('deletes a row', () => {
    upsertImportedConfig(proj, '.cursorrules', { status: 'dismissed', dismissedAt: 5000, createdAt: 5000 })
    deleteImportedConfig(proj, '.cursorrules')
    expect(getImportedConfig(proj, '.cursorrules')).toBeNull()
  })
})
