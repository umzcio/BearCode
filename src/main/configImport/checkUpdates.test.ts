// Task 7 (Agent Config Import plan): checkSourceForUpdate/applySourceUpdate/
// ignoreSourceUpdate/detachSource/dismissDetectedSources sit on top of the
// Task 6 importer (applyImportSelection) + Task 1 DB + Task 3/4 translators.
//
// Same mocking precedent as importer.test.ts: better-sqlite3's native binding
// can't load under plain-Node vitest, so 'electron' and 'better-sqlite3' are
// mocked at module level with a FakeDatabase that regex-matches the SQL
// passed to prepare() against an in-memory Map.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs'
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
import { getImportedConfig } from '../db'

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

  it('detachSource removes the tracking row without touching the imported file', () => {
    detachSource(dir, 'CLAUDE.md')
    expect(getImportedConfig(dir, 'CLAUDE.md')).toBeNull()
    expect(readFileSync(join(dir, '.agents', 'rules', 'claude.md'), 'utf8')).toBe('Original content.')
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
