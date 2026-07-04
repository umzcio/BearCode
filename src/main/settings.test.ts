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
})
