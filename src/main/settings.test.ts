import { describe, it, expect } from 'vitest'
import { migrateSettings } from './settings'

describe('migrateSettings', () => {
  it('seeds defaultPermissionMode from legacy autoApproveCommands=true', () => {
    expect(migrateSettings({ autoApproveCommands: true }).defaultPermissionMode).toBe('auto')
  })
  it('seeds accept-edits from legacy autoApproveCommands=false', () => {
    expect(migrateSettings({ autoApproveCommands: false }).defaultPermissionMode).toBe(
      'accept-edits'
    )
  })
  it('leaves an explicit defaultPermissionMode untouched', () => {
    expect(migrateSettings({ defaultPermissionMode: 'auto' }).defaultPermissionMode).toBe('auto')
  })
  it('drops the legacy key from the result', () => {
    expect('autoApproveCommands' in migrateSettings({ autoApproveCommands: true })).toBe(false)
  })
  it('defaults disabledBuiltins to an empty array', () => {
    expect(migrateSettings({}).disabledBuiltins).toEqual([])
  })
  it('preserves a stored disabledBuiltins list across load (survives restart)', () => {
    expect(
      migrateSettings({ disabledBuiltins: ['builtin:curl-pipe-sh'] }).disabledBuiltins
    ).toEqual(['builtin:curl-pipe-sh'])
  })
  it('drops non-string entries from disabledBuiltins', () => {
    expect(
      migrateSettings({ disabledBuiltins: ['builtin:curl-pipe-sh', 7, null] }).disabledBuiltins
    ).toEqual(['builtin:curl-pipe-sh'])
  })
  it('coerces a non-array disabledBuiltins to empty', () => {
    expect(migrateSettings({ disabledBuiltins: 'builtin:curl-pipe-sh' }).disabledBuiltins).toEqual(
      []
    )
  })
})
