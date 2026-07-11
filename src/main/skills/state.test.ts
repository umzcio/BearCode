import { describe, it, expect, vi, beforeEach } from 'vitest'
let store: Record<string, unknown> = {}
vi.mock('../settings', () => ({
  getSettings: () => store,
  setSettings: (patch: Record<string, unknown>) => {
    store = { ...store, ...patch }
    return store
  }
}))
import { isSkillEnabled, setSkillEnabled, disabledSkillNames } from './state'

describe('skill enable/disable state', () => {
  beforeEach(() => {
    store = {}
  })

  it('skills are enabled by default (empty disabled-set)', () => {
    expect(isSkillEnabled('pdf', 'global', null)).toBe(true)
    expect(isSkillEnabled('proj-skill', 'project', '/p')).toBe(true)
  })

  it('disabling a global skill persists into skillsDisabledGlobal', () => {
    setSkillEnabled('pdf', 'global', null, false)
    expect(store.skillsDisabledGlobal).toEqual(['pdf'])
    expect(isSkillEnabled('pdf', 'global', null)).toBe(false)
  })

  it('disabling a project skill is path-keyed', () => {
    setSkillEnabled('proj', 'project', '/p', false)
    expect((store.skillsDisabledProject as Record<string, string[]>)['/p']).toEqual(['proj'])
    expect(isSkillEnabled('proj', 'project', '/p')).toBe(false)
    expect(isSkillEnabled('proj', 'project', '/other')).toBe(true)
  })

  it('re-enabling removes the name', () => {
    setSkillEnabled('pdf', 'global', null, false)
    setSkillEnabled('pdf', 'global', null, true)
    expect(store.skillsDisabledGlobal).toEqual([])
    expect(isSkillEnabled('pdf', 'global', null)).toBe(true)
  })

  it('disableSkillNames reports both scopes', () => {
    setSkillEnabled('g', 'global', null, false)
    setSkillEnabled('p', 'project', '/p', false)
    expect(disabledSkillNames('/p')).toEqual({ global: ['g'], project: ['p'] })
  })
})
