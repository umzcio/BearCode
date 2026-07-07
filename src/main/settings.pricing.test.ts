import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/nonexistent') } }))
// Keep reads failing (falls back to DEFAULTS) and make writes a no-op so the
// setSettings return value can be asserted without touching a real disk.
vi.mock('fs', () => ({
  readFileSync: vi.fn(() => {
    throw new Error('no file')
  }),
  writeFileSync: vi.fn()
}))

import { migrateSettings, setSettings } from './settings'

describe('migrateSettings pricing coercion', () => {
  it('defaults modelPricing to {} and modelPricingSyncedAt to 0 when missing', () => {
    const s = migrateSettings({})
    expect(s.modelPricing).toEqual({})
    expect(s.modelPricingSyncedAt).toBe(0)
  })
  it('round-trips a valid pricing map across load', () => {
    const map = { 'openai/gpt-5.1': { inputPer1M: 2, outputPer1M: 8 } }
    const s = migrateSettings({ modelPricing: map, modelPricingSyncedAt: 1720000000000 })
    expect(s.modelPricing).toEqual(map)
    expect(s.modelPricingSyncedAt).toBe(1720000000000)
  })
  it('drops a garbage entry (non-numeric price)', () => {
    const s = migrateSettings({ modelPricing: { x: { inputPer1M: 'a', outputPer1M: 8 } } })
    expect(s.modelPricing).toEqual({})
  })
  it('drops an entry with a negative price', () => {
    const s = migrateSettings({
      modelPricing: { 'openai/gpt-5.1': { inputPer1M: -2, outputPer1M: 8 } }
    })
    expect(s.modelPricing).toEqual({})
  })
  it('keeps the good entries and drops the bad ones in the same map', () => {
    const s = migrateSettings({
      modelPricing: {
        'openai/gpt-5.1': { inputPer1M: 2, outputPer1M: 8 },
        bad: { inputPer1M: -1, outputPer1M: 8 }
      }
    })
    expect(s.modelPricing).toEqual({ 'openai/gpt-5.1': { inputPer1M: 2, outputPer1M: 8 } })
  })
  it('coerces a non-object modelPricing to {}', () => {
    expect(migrateSettings({ modelPricing: 'nope' }).modelPricing).toEqual({})
  })
  it('coerces a non-numeric modelPricingSyncedAt to 0', () => {
    expect(migrateSettings({ modelPricingSyncedAt: 'yesterday' }).modelPricingSyncedAt).toBe(0)
  })
})

describe('setSettings pricing validation', () => {
  it('coerces a garbage patch before persisting (bad entries dropped)', () => {
    const next = setSettings({
      modelPricing: {
        'openai/gpt-5.1': { inputPer1M: 2, outputPer1M: 8 },
        bad: { inputPer1M: 'x' } as never
      }
    })
    expect(next.modelPricing).toEqual({ 'openai/gpt-5.1': { inputPer1M: 2, outputPer1M: 8 } })
  })
  it('drops a negative price on write', () => {
    const next = setSettings({
      modelPricing: { 'openai/gpt-5.1': { inputPer1M: -2, outputPer1M: 8 } }
    })
    expect(next.modelPricing).toEqual({})
  })
})
