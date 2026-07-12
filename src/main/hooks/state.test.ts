import { describe, it, expect, vi, beforeEach } from 'vitest'
let store: Record<string, unknown> = {}
vi.mock('../settings', () => ({
  getSettings: () => store,
  setSettings: (patch: Record<string, unknown>) => {
    store = { ...store, ...patch }
    return store
  }
}))
import { isHookActive, setHookActive } from './state'

describe('hook consent/enable state', () => {
  beforeEach(() => {
    store = {}
  })

  it('global hooks are active by default', () => {
    expect(isHookActive({ scope: 'global', name: 'fmt' }, null)).toBe(true)
  })

  it('setHookActive(global, ..., false) disables a global hook', () => {
    setHookActive('global', 'global', 'fmt', false)
    expect(store.hooksDisabledGlobal).toEqual(['fmt'])
    expect(isHookActive({ scope: 'global', name: 'fmt' }, null)).toBe(false)
  })

  it('re-enabling a global hook removes it from the disabled-set', () => {
    setHookActive('global', 'global', 'fmt', false)
    setHookActive('global', 'global', 'fmt', true)
    expect(store.hooksDisabledGlobal).toEqual([])
    expect(isHookActive({ scope: 'global', name: 'fmt' }, null)).toBe(true)
  })

  it('project hooks are inactive by default', () => {
    expect(isHookActive({ scope: 'project', name: 'h' }, '/p')).toBe(false)
  })

  it('setHookActive(project, ...) activates via hooksConsented', () => {
    setHookActive('project', '/p', 'h', true)
    expect(store.hooksConsented).toEqual(['project:/p:h'])
    expect(isHookActive({ scope: 'project', name: 'h' }, '/p')).toBe(true)
    expect(isHookActive({ scope: 'project', name: 'h' }, '/other')).toBe(false)
  })

  it('revoking project consent removes the key', () => {
    setHookActive('project', '/p', 'h', true)
    setHookActive('project', '/p', 'h', false)
    expect(store.hooksConsented).toEqual([])
    expect(isHookActive({ scope: 'project', name: 'h' }, '/p')).toBe(false)
  })

  it('plugin hooks are inactive by default and activate via hooksConsented keyed by plugin name', () => {
    expect(isHookActive({ scope: 'plugin', plugin: 'my-plugin', name: 'guard' }, '/p')).toBe(false)
    setHookActive('plugin', 'my-plugin', 'guard', true)
    expect(store.hooksConsented).toEqual(['plugin:my-plugin:guard'])
    expect(isHookActive({ scope: 'plugin', plugin: 'my-plugin', name: 'guard' }, '/p')).toBe(true)
  })
})
