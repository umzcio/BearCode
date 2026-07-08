import { describe, it, expect } from 'vitest'
import { presetToSettings, settingsToPreset, PRESET_VALUES } from './securityPreset'

describe('presetToSettings', () => {
  it('Default → ask / ask / require-review', () => {
    expect(presetToSettings('default')).toEqual({
      defaultPermissionMode: 'ask',
      fileAccessPolicy: 'ask',
      terminalAutoExec: 'require-review'
    })
  })
  it('Full Autonomy → auto / allow / auto', () => {
    expect(presetToSettings('full-autonomy')).toEqual({
      defaultPermissionMode: 'auto',
      fileAccessPolicy: 'allow',
      terminalAutoExec: 'auto'
    })
  })
  it('Custom → no change', () => {
    expect(presetToSettings('custom')).toEqual({})
  })
})

describe('settingsToPreset', () => {
  it('recognizes each preset from exact primitives', () => {
    expect(settingsToPreset(PRESET_VALUES.default)).toBe('default')
    expect(settingsToPreset(PRESET_VALUES['full-autonomy'])).toBe('full-autonomy')
  })
  it('round-trips both presets', () => {
    for (const p of ['default', 'full-autonomy'] as const) {
      expect(settingsToPreset(presetToSettings(p) as never)).toBe(p)
    }
  })
  it('editing one field away from a preset → custom', () => {
    expect(
      settingsToPreset({ ...PRESET_VALUES['full-autonomy'], terminalAutoExec: 'require-review' })
    ).toBe('custom')
  })
  it('the behavior-preserving default (accept-edits/deny/auto) → custom', () => {
    expect(
      settingsToPreset({
        defaultPermissionMode: 'accept-edits',
        fileAccessPolicy: 'deny',
        terminalAutoExec: 'auto'
      })
    ).toBe('custom')
  })
  it('tolerates missing optional fields (treats as deny/auto)', () => {
    expect(settingsToPreset({ defaultPermissionMode: 'ask' })).toBe('custom')
  })
})
