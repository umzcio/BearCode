import { describe, it, expect } from 'vitest'
import type { PermissionRule } from '../../shared/types'
import { mergeRules } from './store'
import { BUILTIN_RULES } from './rules'

const g = (match: string): PermissionRule => ({
  id: 'g:' + match,
  scope: 'global',
  action: 'command',
  match,
  effect: 'allow',
  source: 'user'
})
const p = (match: string, projectPath: string): PermissionRule => ({
  id: 'p:' + match,
  scope: { projectPath },
  action: 'command',
  match,
  effect: 'allow',
  source: 'user'
})

describe('mergeRules', () => {
  it('includes all builtins plus global user rules', () => {
    const out = mergeRules([g('git *')], null)
    expect(out).toEqual(expect.arrayContaining(BUILTIN_RULES))
    expect(out.some((r) => r.match === 'git *')).toBe(true)
  })
  it('includes a project rule only for its own project', () => {
    const rules = [p('npm *', '/a'), p('cargo *', '/b')]
    const forA = mergeRules(rules, '/a')
    expect(forA.some((r) => r.match === 'npm *')).toBe(true)
    expect(forA.some((r) => r.match === 'cargo *')).toBe(false)
  })
  it('excludes all project rules when projectPath is null', () => {
    expect(mergeRules([p('npm *', '/a')], null).some((r) => r.match === 'npm *')).toBe(false)
  })
})
