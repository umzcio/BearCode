import { describe, it, expect } from 'vitest'
import { migrateSettings, setSettings, SELECTABLE_PERMISSION_MODES } from './settings'

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
  it("defaults artifactReviewPolicy to 'request-review'", () => {
    expect(migrateSettings({}).artifactReviewPolicy).toBe('request-review')
  })
  it("preserves a stored 'always-proceed' policy across load (survives restart)", () => {
    expect(migrateSettings({ artifactReviewPolicy: 'always-proceed' }).artifactReviewPolicy).toBe(
      'always-proceed'
    )
  })
  it('coerces an unknown policy value to the request-review default', () => {
    expect(migrateSettings({ artifactReviewPolicy: 'yolo' }).artifactReviewPolicy).toBe(
      'request-review'
    )
    expect(migrateSettings({ artifactReviewPolicy: 7 }).artifactReviewPolicy).toBe('request-review')
  })
})

describe('migrateSettings defaultPermissionMode coercion', () => {
  it("defaults defaultPermissionMode to 'accept-edits'", () => {
    expect(migrateSettings({}).defaultPermissionMode).toBe('accept-edits')
  })
  it('preserves each selectable mode across load', () => {
    for (const mode of SELECTABLE_PERMISSION_MODES) {
      expect(migrateSettings({ defaultPermissionMode: mode }).defaultPermissionMode).toBe(mode)
    }
  })
  it("coerces bypass (never a valid default) to 'accept-edits' on read", () => {
    expect(migrateSettings({ defaultPermissionMode: 'bypass' }).defaultPermissionMode).toBe(
      'accept-edits'
    )
  })
  it("coerces an unknown persisted value to 'accept-edits' on read", () => {
    expect(migrateSettings({ defaultPermissionMode: 'turbo' }).defaultPermissionMode).toBe(
      'accept-edits'
    )
    expect(migrateSettings({ defaultPermissionMode: 7 }).defaultPermissionMode).toBe('accept-edits')
  })
})

describe('setSettings defaultPermissionMode validation', () => {
  it('rejects a write that sets defaultPermissionMode to bypass', () => {
    expect(() => setSettings({ defaultPermissionMode: 'bypass' as never })).toThrow(
      /defaultPermissionMode/
    )
  })
  it('rejects a write that sets an unknown defaultPermissionMode', () => {
    expect(() => setSettings({ defaultPermissionMode: 'turbo' as never })).toThrow(
      /defaultPermissionMode/
    )
  })
})
