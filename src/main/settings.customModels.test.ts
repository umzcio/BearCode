import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/nonexistent') } }))
// Reads fail (falls back to DEFAULTS); writes are a no-op so setSettings return
// values can be asserted without touching a real disk.
vi.mock('fs', () => ({
  readFileSync: vi.fn(() => {
    throw new Error('no file')
  }),
  writeFileSync: vi.fn()
}))

import { migrateSettings, setSettings } from './settings'

describe('migrateSettings: disabledModels', () => {
  it('defaults missing to []', () => {
    expect(migrateSettings({}).disabledModels).toEqual([])
  })
  it('keeps a string[] and drops non-strings', () => {
    expect(
      migrateSettings({ disabledModels: ['openai/gpt-4.1', 3, null] }).disabledModels
    ).toEqual(['openai/gpt-4.1'])
  })
  it('collapses a non-array to []', () => {
    expect(migrateSettings({ disabledModels: 'nope' }).disabledModels).toEqual([])
  })
})

describe('migrateSettings: customModels', () => {
  it('defaults missing to []', () => {
    expect(migrateSettings({}).customModels).toEqual([])
  })
  it('keeps well-formed entries, drops malformed', () => {
    const raw = {
      customModels: [
        {
          provider: 'google',
          id: 'gemini-3.1-pro',
          label: 'Gemini 3.1 Pro',
          contextWindow: 1000000
        },
        { provider: 'nope', id: 'x', label: 'X', contextWindow: 1 }, // bad provider
        { provider: 'openai', id: '', label: 'Empty id', contextWindow: 1 }, // empty id
        { provider: 'openai', id: 'y', label: '', contextWindow: 1 }, // empty label
        { provider: 'openai', id: 'y', label: 'Y', contextWindow: -5 }, // bad window
        { provider: 'openai', id: 'z', label: 'Z' } // missing window
      ]
    }
    expect(migrateSettings(raw).customModels).toEqual([
      { provider: 'google', id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', contextWindow: 1000000 }
    ])
  })
})

describe('setSettings validation', () => {
  it('coerces malformed customModels on write instead of persisting them', () => {
    const out = setSettings({
      customModels: [
        { provider: 'openai', id: 'good', label: 'Good', contextWindow: 400000 },
        { provider: 'bad', id: 'x', label: 'X', contextWindow: 1 } as never
      ]
    })
    expect(out.customModels).toEqual([
      { provider: 'openai', id: 'good', label: 'Good', contextWindow: 400000 }
    ])
  })
  it('coerces a non-array disabledModels on write to []', () => {
    const out = setSettings({ disabledModels: 'nope' as never })
    expect(out.disabledModels).toEqual([])
  })
})
