import { describe, it, expect, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/nonexistent') } }))
import { migrateSettings } from './settings'

describe('sidebar display settings', () => {
  it('defaults to project + updated', () => {
    const s = migrateSettings({})
    expect(s.sidebarGroupBy).toBe('project')
    expect(s.sidebarSort).toBe('updated')
  })
  it('coerces invalid values to defaults', () => {
    expect(migrateSettings({ sidebarGroupBy: 'env' }).sidebarGroupBy).toBe('project')
    expect(migrateSettings({ sidebarSort: 'zzz' }).sidebarSort).toBe('updated')
  })
  it('keeps valid values', () => {
    expect(migrateSettings({ sidebarGroupBy: 'none' }).sidebarGroupBy).toBe('none')
    expect(migrateSettings({ sidebarSort: 'alpha' }).sidebarSort).toBe('alpha')
  })
  // F3: the group-by union widened to include environment/status and a new
  // sidebarSubtitle was added. Guard the migration so a future refactor that
  // narrows the allow-list back can't silently reset a user's grouping on reload.
  it('keeps the F3 environment/status group-by across reload', () => {
    expect(migrateSettings({ sidebarGroupBy: 'environment' }).sidebarGroupBy).toBe('environment')
    expect(migrateSettings({ sidebarGroupBy: 'status' }).sidebarGroupBy).toBe('status')
  })
  it('defaults sidebarSubtitle to none and keeps/coerces it', () => {
    expect(migrateSettings({}).sidebarSubtitle).toBe('none')
    expect(migrateSettings({ sidebarSubtitle: 'worktree' }).sidebarSubtitle).toBe('worktree')
    expect(migrateSettings({ sidebarSubtitle: 'garbage' }).sidebarSubtitle).toBe('none')
  })
})
