import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/nonexistent') } }))
// Reads fail (falls back to DEFAULTS); writes are a no-op so setSettings return
// values can be asserted without touching a real disk. Same pattern as
// settings.customModels.test.ts.
vi.mock('fs', () => ({
  readFileSync: vi.fn(() => {
    throw new Error('no file')
  }),
  writeFileSync: vi.fn()
}))

import { getSettings, setSettings } from './settings'

describe('ursaEnabled', () => {
  it('defaults to false', () => {
    expect(getSettings().ursaEnabled).toBe(false)
  })

  it('round-trips true through setSettings', () => {
    setSettings({ ursaEnabled: true })
    expect(getSettings().ursaEnabled).toBe(true)
  })

  it('coerces a non-boolean write to false rather than persisting garbage', () => {
    setSettings({ ursaEnabled: 'yes' as never })
    expect(getSettings().ursaEnabled).toBe(false)
  })
})
