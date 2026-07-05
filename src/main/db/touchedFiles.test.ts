// Pins touchedFilesFor's row-mapping (touchedFilesFromRows): distinct,
// null-filtered file paths out of the two shapes a tool_call's JSON payload
// carries a path under. better-sqlite3's native binding is compiled for
// Electron's ABI and cannot load under plain-Node vitest, so both 'electron'
// and 'better-sqlite3' are mocked at module level and no database is opened
// (same precedent as rules.test.ts's toRule tests).
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/nonexistent') }
}))
vi.mock('better-sqlite3', () => ({
  default: vi.fn()
}))

import { touchedFilesFromRows, normalizeTouchedPath, type TouchedFileRow } from './index'
import { matchesEditPath } from '../permissions/rules'

describe('touchedFilesFromRows', () => {
  it('collects file_path values from write_file/edit_file rows', () => {
    const rows: TouchedFileRow[] = [
      { file_path: 'src/a.ts', path: null },
      { file_path: 'src/b.ts', path: null }
    ]
    expect(touchedFilesFromRows(rows)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('collects path values from read_file rows', () => {
    const rows: TouchedFileRow[] = [{ file_path: null, path: 'src/c.ts' }]
    expect(touchedFilesFromRows(rows)).toEqual(['src/c.ts'])
  })

  it('filters out nulls', () => {
    const rows: TouchedFileRow[] = [{ file_path: null, path: null }]
    expect(touchedFilesFromRows(rows)).toEqual([])
  })

  it('dedupes repeated paths, keeping first-seen order', () => {
    const rows: TouchedFileRow[] = [
      { file_path: 'src/a.ts', path: null },
      { file_path: 'src/b.ts', path: null },
      { file_path: 'src/a.ts', path: null }
    ]
    expect(touchedFilesFromRows(rows)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('dedupes across the file_path and path columns for the same row', () => {
    const rows: TouchedFileRow[] = [{ file_path: 'src/a.ts', path: 'src/a.ts' }]
    expect(touchedFilesFromRows(rows)).toEqual(['src/a.ts'])
  })

  it('returns [] for no rows', () => {
    expect(touchedFilesFromRows([])).toEqual([])
  })

  it('strips a leading / (root-relative convention) so glob matching still works', () => {
    const rows: TouchedFileRow[] = [{ file_path: '/src/a.ts', path: null }]
    expect(touchedFilesFromRows(rows)).toEqual(['src/a.ts'])
  })

  it('dedupes a root-relative and workspace-relative row referring to the same path', () => {
    const rows: TouchedFileRow[] = [
      { file_path: '/src/a.ts', path: null },
      { file_path: 'src/a.ts', path: null }
    ]
    expect(touchedFilesFromRows(rows)).toEqual(['src/a.ts'])
  })
})

describe('normalizeTouchedPath', () => {
  it('strips a leading / so a glob like src/** matches a root-relative path', () => {
    expect(normalizeTouchedPath('/src/a.ts')).toBe('src/a.ts')
    expect(matchesEditPath('src/**', normalizeTouchedPath('/src/a.ts'))).toBe(true)
  })

  it('leaves a ./-relative path unchanged (no leading slash to strip)', () => {
    expect(normalizeTouchedPath('./x')).toBe('./x')
  })

  it('leaves a bare relative path unchanged', () => {
    expect(normalizeTouchedPath('x')).toBe('x')
  })
})
