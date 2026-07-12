import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({ app: { getPath: () => mkdtempSync(join(tmpdir(), 'bc-set-')) } }))

describe('plugin settings keys', () => {
  beforeEach(() => vi.resetModules())
  it('persists pluginsEnabled and marketplaces as string arrays', async () => {
    const { getSettings, setSettings } = await import('./settings')
    setSettings({ pluginsEnabled: ['global:foo'], marketplaces: ['https://x/y'] })
    expect(getSettings().pluginsEnabled).toEqual(['global:foo'])
    expect(getSettings().marketplaces).toEqual(['https://x/y'])
  })
  it('coerces non-array plugin keys to empty and ignores junk entries', async () => {
    const { getSettings, setSettings } = await import('./settings')
    // @ts-expect-error deliberate bad input
    setSettings({ pluginsEnabled: 'nope', marketplaces: [1, 'https://ok', null] })
    expect(getSettings().pluginsEnabled).toEqual([])
    expect(getSettings().marketplaces).toEqual(['https://ok'])
  })
})
