import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({ app: { getPath: () => mkdtempSync(join(tmpdir(), 'bc-set-')) } }))

describe('hooks settings keys', () => {
  beforeEach(() => vi.resetModules())
  it('persists hooksDisabledGlobal and hooksConsented as string arrays', async () => {
    const { getSettings, setSettings } = await import('./settings')
    setSettings({ hooksDisabledGlobal: ['x'], hooksConsented: ['project:/p:h'] })
    expect(getSettings().hooksDisabledGlobal).toEqual(['x'])
    expect(getSettings().hooksConsented).toEqual(['project:/p:h'])
  })
  it('coerces non-array hooks keys to empty and ignores junk entries', async () => {
    const { getSettings, setSettings } = await import('./settings')
    // @ts-expect-error deliberate bad input
    setSettings({ hooksDisabledGlobal: 'nope', hooksConsented: [1, 'project:/p:h', null] })
    expect(getSettings().hooksDisabledGlobal).toEqual([])
    expect(getSettings().hooksConsented).toEqual(['project:/p:h'])
  })
})
