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
})
