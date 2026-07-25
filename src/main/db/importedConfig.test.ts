import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const testDir = mkdtempSync(join(tmpdir(), 'bearcode-test-'))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => testDir) }
}))

import { upsertImportedConfig, listImportedConfig, getImportedConfig, deleteImportedConfig } from './index'

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
    upsertImportedConfig(proj, '.cursorrules', { status: 'dismissed', dismissedAt: 5000, createdAt: 5000 })
    const rows = listImportedConfig(proj)
    expect(rows.map((r) => r.sourcePath)).toEqual(
      expect.arrayContaining(['CLAUDE.md', 'AGENTS.md', '.cursorrules'])
    )
  })

  it('deletes a row', () => {
    deleteImportedConfig(proj, '.cursorrules')
    expect(getImportedConfig(proj, '.cursorrules')).toBeNull()
  })
})
