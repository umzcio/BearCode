import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/nonexistent') } }))
vi.mock('fs', () => ({
  readFileSync: vi.fn(() => {
    throw new Error('no file')
  }),
  writeFileSync: vi.fn()
}))

import { migrateSettings, setSettings } from './settings'

describe('migrateSettings: F8 agent settings defaults (behavior-preserving)', () => {
  it('defaults missing fields to custom / deny / auto', () => {
    const s = migrateSettings({})
    expect(s.securityPreset).toBe('custom')
    expect(s.fileAccessPolicy).toBe('deny')
    expect(s.terminalAutoExec).toBe('auto')
  })
  it('keeps valid values', () => {
    const s = migrateSettings({
      securityPreset: 'full-autonomy',
      fileAccessPolicy: 'allow',
      terminalAutoExec: 'require-review'
    })
    expect(s.securityPreset).toBe('full-autonomy')
    expect(s.fileAccessPolicy).toBe('allow')
    expect(s.terminalAutoExec).toBe('require-review')
  })
  it('coerces garbage back to the safe defaults', () => {
    const s = migrateSettings({
      securityPreset: 'nope',
      fileAccessPolicy: 'wide-open',
      terminalAutoExec: 'yolo'
    })
    expect(s.securityPreset).toBe('custom')
    expect(s.fileAccessPolicy).toBe('deny')
    expect(s.terminalAutoExec).toBe('auto')
  })
})

describe('setSettings: F8 write validation', () => {
  it('rejects an invalid securityPreset', () => {
    expect(() => setSettings({ securityPreset: 'nope' as never })).toThrow(/securityPreset/)
  })
  it('rejects an invalid fileAccessPolicy', () => {
    expect(() => setSettings({ fileAccessPolicy: 'wide-open' as never })).toThrow(
      /fileAccessPolicy/
    )
  })
  it('rejects an invalid terminalAutoExec', () => {
    expect(() => setSettings({ terminalAutoExec: 'yolo' as never })).toThrow(/terminalAutoExec/)
  })
  it('accepts valid values', () => {
    const out = setSettings({ fileAccessPolicy: 'allow', terminalAutoExec: 'require-review' })
    expect(out.fileAccessPolicy).toBe('allow')
    expect(out.terminalAutoExec).toBe('require-review')
  })
})
