import { describe, it, expect, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/nonexistent') } }))
import { migrateSettings } from './settings'

// F4 Task 11: browserEnabled/browserAllowlist/browserBlocklist are real
// AppSettings fields now. Off-by-default + malformed-input coercion, mirroring
// settings.sidebar.test.ts's pattern.
describe('browser settings', () => {
  it('defaults to disabled with empty domain lists', () => {
    const s = migrateSettings({})
    expect(s.browserEnabled).toBe(false)
    expect(s.browserAllowlist).toEqual([])
    expect(s.browserBlocklist).toEqual([])
  })

  it('coerces a garbage browserEnabled to false', () => {
    expect(migrateSettings({ browserEnabled: 'yes' }).browserEnabled).toBe(false)
    expect(migrateSettings({ browserEnabled: 1 }).browserEnabled).toBe(false)
    expect(migrateSettings({ browserEnabled: null }).browserEnabled).toBe(false)
  })

  it('keeps a valid browserEnabled true', () => {
    expect(migrateSettings({ browserEnabled: true }).browserEnabled).toBe(true)
  })

  it('coerces a non-array allowlist/blocklist to []', () => {
    expect(migrateSettings({ browserAllowlist: 'example.com' }).browserAllowlist).toEqual([])
    expect(migrateSettings({ browserBlocklist: 123 }).browserBlocklist).toEqual([])
    expect(migrateSettings({ browserAllowlist: null }).browserAllowlist).toEqual([])
  })

  it('keeps valid domain arrays and drops non-string entries', () => {
    expect(
      migrateSettings({ browserAllowlist: ['example.com', 'foo.dev'] }).browserAllowlist
    ).toEqual(['example.com', 'foo.dev'])
    expect(migrateSettings({ browserBlocklist: ['bad.com', 42, null] }).browserBlocklist).toEqual([
      'bad.com'
    ])
  })
})
