import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/nonexistent') } }))

import { migrateSettings } from './settings'
import { isSttBackend } from '../shared/types'

describe('settings sttBackend defaults', () => {
  it('defaults a missing sttBackend to openai', () => {
    expect(migrateSettings({}).sttBackend).toBe('openai')
  })
  it("round-trips 'local'", () => {
    expect(migrateSettings({ sttBackend: 'local' }).sttBackend).toBe('local')
  })
  it('coerces garbage to openai', () => {
    expect(migrateSettings({ sttBackend: 'whisper' }).sttBackend).toBe('openai')
    expect(migrateSettings({ sttBackend: 42 }).sttBackend).toBe('openai')
    expect(migrateSettings({ sttBackend: null }).sttBackend).toBe('openai')
  })
})

describe('isSttBackend guard', () => {
  it('accepts the two valid backends', () => {
    expect(isSttBackend('openai')).toBe(true)
    expect(isSttBackend('local')).toBe(true)
  })
  it('rejects anything else', () => {
    expect(isSttBackend('whisper')).toBe(false)
    expect(isSttBackend(42)).toBe(false)
    expect(isSttBackend(undefined)).toBe(false)
    expect(isSttBackend(null)).toBe(false)
  })
})
