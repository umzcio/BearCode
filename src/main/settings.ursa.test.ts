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

describe('ursaRoles / ursaGuardrails', () => {
  it('defaults to an empty roles array and empty ceilings', () => {
    const s = getSettings()
    expect(s.ursaRoles).toEqual([])
    expect(s.ursaGuardrails).toEqual({ roleCeilings: {} })
  })

  it('round-trips a well-formed role through setSettings', () => {
    const role = { name: 'coder', modelRef: 'openai/gpt-5.6-sol', description: 'Writes code' }
    setSettings({ ursaRoles: [role] })
    expect(getSettings().ursaRoles).toEqual([role])
  })

  it('drops a malformed role (missing modelRef) on write', () => {
    setSettings({
      ursaRoles: [{ name: 'bad', description: 'no modelRef' } as never]
    })
    expect(getSettings().ursaRoles).toEqual([])
  })
})
