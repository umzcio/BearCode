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

describe('migrateSettings profile + custom instructions coercion', () => {
  it('defaults profileName, profileCallMe, customInstructions to empty strings', () => {
    const s = migrateSettings({})
    expect(s.profileName).toBe('')
    expect(s.profileCallMe).toBe('')
    expect(s.customInstructions).toBe('')
  })
  it('preserves provided string values across load', () => {
    const s = migrateSettings({
      profileName: 'Zach',
      profileCallMe: 'Z',
      customInstructions: 'Always use TS.'
    })
    expect(s.profileName).toBe('Zach')
    expect(s.profileCallMe).toBe('Z')
    expect(s.customInstructions).toBe('Always use TS.')
  })
  it('coerces non-string values to empty strings', () => {
    const s = migrateSettings({ profileName: 7, profileCallMe: null, customInstructions: {} })
    expect(s.profileName).toBe('')
    expect(s.profileCallMe).toBe('')
    expect(s.customInstructions).toBe('')
  })
})

describe('migrateSettings Ursus coercion', () => {
  it('defaults ursusEnabled to false and ursusInstructions to empty string', () => {
    const s = migrateSettings({})
    expect(s.ursusEnabled).toBe(false)
    expect(s.ursusInstructions).toBe('')
  })
  it('coerces a non-boolean ursusEnabled to false', () => {
    expect(migrateSettings({ ursusEnabled: 'yes' }).ursusEnabled).toBe(false)
  })
  it('preserves ursusEnabled: true across load', () => {
    expect(migrateSettings({ ursusEnabled: true }).ursusEnabled).toBe(true)
  })
  it('caps ursusInstructions at 2000 chars on migrate', () => {
    const s = migrateSettings({ ursusInstructions: 'x'.repeat(3000) })
    expect(s.ursusInstructions).toHaveLength(2000)
  })
  it('coerces a non-string ursusInstructions to empty string', () => {
    expect(migrateSettings({ ursusInstructions: 12345 }).ursusInstructions).toBe('')
  })
})

describe('setSettings Ursus validation', () => {
  it('persists ursusEnabled as a coerced boolean', () => {
    expect(setSettings({ ursusEnabled: true }).ursusEnabled).toBe(true)
  })
  it('caps ursusInstructions at write time too', () => {
    expect(setSettings({ ursusInstructions: 'y'.repeat(3000) }).ursusInstructions).toHaveLength(
      2000
    )
  })
})
