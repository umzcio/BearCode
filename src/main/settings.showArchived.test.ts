import { describe, it, expect, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/nonexistent') } }))
import { migrateSettings } from './settings'

describe('sidebarShowArchived setting', () => {
  it('defaults to false', () => {
    expect(migrateSettings({}).sidebarShowArchived).toBe(false)
  })
  it('keeps a true value', () => {
    expect(migrateSettings({ sidebarShowArchived: true }).sidebarShowArchived).toBe(true)
  })
  it('coerces a non-boolean to false', () => {
    expect(migrateSettings({ sidebarShowArchived: 'yes' }).sidebarShowArchived).toBe(false)
  })
})
