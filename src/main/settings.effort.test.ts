import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/nonexistent') } }))

import { migrateSettings } from './settings'

describe('settings effort/thinking defaults', () => {
  it('defaults to adaptive effort + thinking on', () => {
    const s = migrateSettings({})
    expect(s.defaultEffort).toBe('adaptive')
    expect(s.defaultThinking).toBe(true)
  })
  it('coerces an invalid defaultEffort to adaptive', () => {
    expect(migrateSettings({ defaultEffort: 'ultra' }).defaultEffort).toBe('adaptive')
    expect(migrateSettings({ defaultEffort: 7 }).defaultEffort).toBe('adaptive')
  })
  it('keeps a valid defaultEffort', () => {
    expect(migrateSettings({ defaultEffort: 'high' }).defaultEffort).toBe('high')
  })
  it('coerces defaultThinking to a boolean (default true)', () => {
    expect(migrateSettings({ defaultThinking: false }).defaultThinking).toBe(false)
    expect(migrateSettings({ defaultThinking: 'yes' }).defaultThinking).toBe(true)
  })
})
