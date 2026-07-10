import { describe, it, expect } from 'vitest'
import { matchesIntegration, evaluateIntegration } from './rules'
import type { PermissionRule } from '../../shared/types'
const R = (match: string, effect: 'allow' | 'deny' | 'ask'): PermissionRule => ({
  id: match,
  scope: 'global',
  action: 'integration',
  match,
  effect,
  source: 'user'
})

describe('matchesIntegration', () => {
  it('whole provider: bare name and .*', () => {
    expect(matchesIntegration('github', 'github', 'anything')).toBe(true)
    expect(matchesIntegration('github.*', 'github', 'anything')).toBe(true)
    expect(matchesIntegration('github', 'bitbucket', 'x')).toBe(false)
  })
  it('exact tool', () => {
    expect(matchesIntegration('github.create_pr', 'github', 'create_pr')).toBe(true)
    expect(matchesIntegration('github.create_pr', 'github', 'list_repos')).toBe(false)
  })
  it('prefix wildcard', () => {
    expect(matchesIntegration('github.list_*', 'github', 'list_repos')).toBe(true)
    expect(matchesIntegration('github.list_*', 'github', 'create_pr')).toBe(false)
  })
  it('provider portion is a literal: no cross-provider matching', () => {
    expect(matchesIntegration('git*', 'github', 'anything')).toBe(false)
    expect(matchesIntegration('*', 'anything', 'anything')).toBe(false)
    expect(matchesIntegration('*.create_pr', 'github', 'create_pr')).toBe(false)
  })
})

describe('evaluateIntegration', () => {
  it('default Ask (no rules)', () => {
    expect(evaluateIntegration('github', 'create_pr', 'ask', [], false)).toBe('prompt')
  })
  it('deny beats allow', () => {
    expect(
      evaluateIntegration(
        'github',
        'create_pr',
        'auto',
        [R('github.*', 'allow'), R('github.create_pr', 'deny')],
        false
      )
    ).toBe('block')
  })
  it('allow -> run', () => {
    expect(
      evaluateIntegration('github', 'list_repos', 'ask', [R('github.*', 'allow')], false)
    ).toBe('run')
  })
  it('plan mode blocks mutations, allows read-only-tagged tools (still gated to prompt)', () => {
    expect(evaluateIntegration('github', 'create_pr', 'plan', [], false)).toBe('block')
    expect(evaluateIntegration('github', 'list_repos', 'plan', [], true)).toBe('prompt')
    expect(
      evaluateIntegration('github', 'list_repos', 'plan', [R('github.*', 'allow')], true)
    ).toBe('run')
    expect(
      evaluateIntegration('github', 'create_pr', 'plan', [R('github.create_pr', 'deny')], true)
    ).toBe('block') // deny still wins
  })
})
