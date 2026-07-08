import { describe, it, expect } from 'vitest'
import { SETTINGS_NAV, SETTINGS_FOOTER, FEEDBACK_URL } from './SettingsNav'

describe('SETTINGS_NAV', () => {
  it('has two groups labelled Settings and Customize with exact item ids/order', () => {
    expect(SETTINGS_NAV.map((g) => g.label)).toEqual(['Settings', 'Customize'])
    expect(SETTINGS_NAV[0].items.map((i) => i.id)).toEqual([
      'general',
      'permissions',
      'appearance',
      'providers',
      'models'
    ])
    expect(SETTINGS_NAV[1].items.map((i) => i.id)).toEqual([
      'skills',
      'connectors',
      'memory',
      'integrations',
      'browser'
    ])
  })

  it('has SETTINGS_FOOTER = [shortcuts, feedback]', () => {
    expect(SETTINGS_FOOTER.map((i) => i.id)).toEqual(['shortcuts', 'feedback'])
  })

  it('has unique ids across nav+footer', () => {
    const allIds = [
      ...SETTINGS_NAV.flatMap((g) => g.items.map((i) => i.id)),
      ...SETTINGS_FOOTER.map((i) => i.id)
    ]
    expect(new Set(allIds).size).toBe(allIds.length)
  })

  it('has non-empty label and icon for every item', () => {
    const allItems = [...SETTINGS_NAV.flatMap((g) => g.items), ...SETTINGS_FOOTER]
    for (const item of allItems) {
      expect(item.label.length).toBeGreaterThan(0)
      expect(item.icon.length).toBeGreaterThan(0)
    }
  })

  it('has FEEDBACK_URL starting with https://', () => {
    expect(FEEDBACK_URL.startsWith('https://')).toBe(true)
  })
})
