import { describe, it, expect } from 'vitest'
import { matchesMcpTool, evaluateMcp } from './rules'
import type { PermissionRule } from '../../shared/types'
const R = (match: string, effect: 'allow' | 'deny' | 'ask'): PermissionRule => ({
  id: match,
  scope: 'global',
  action: 'mcp',
  match,
  effect,
  source: 'user'
})

describe('matchesMcpTool', () => {
  it('whole server: bare name and .*', () => {
    expect(matchesMcpTool('github', 'github', 'anything')).toBe(true)
    expect(matchesMcpTool('github.*', 'github', 'anything')).toBe(true)
    expect(matchesMcpTool('github', 'gitlab', 'x')).toBe(false)
  })
  it('exact tool', () => {
    expect(matchesMcpTool('github.get_issue', 'github', 'get_issue')).toBe(true)
    expect(matchesMcpTool('github.get_issue', 'github', 'get_repo')).toBe(false)
  })
  it('prefix wildcard', () => {
    expect(matchesMcpTool('github.get_*', 'github', 'get_issue')).toBe(true)
    expect(matchesMcpTool('github.get_*', 'github', 'set_issue')).toBe(false)
  })
  it('server portion is a literal: a glob in the server slot never crosses servers', () => {
    // `git*` must NOT auto-run every `git…`-named server (allow over-matching
    // crosses trust boundaries).
    expect(matchesMcpTool('git*', 'gitlab', 'delete_project')).toBe(false)
    expect(matchesMcpTool('git*', 'github', 'anything')).toBe(false)
    // bare `*` is not "everything everywhere".
    expect(matchesMcpTool('*', 'anything', 'anything')).toBe(false)
    // a wildcard server + literal tool never crosses servers.
    expect(matchesMcpTool('*.get_issue', 'github', 'get_issue')).toBe(false)
  })
  it('glob is only honored as a trailing char after the server. prefix', () => {
    // interior star is not the designed grammar -> matches nothing.
    expect(matchesMcpTool('github.g*t', 'github', 'get')).toBe(false)
    // trailing star still works.
    expect(matchesMcpTool('github.*', 'github', 'x')).toBe(true)
  })
})
describe('evaluateMcp', () => {
  it('default Ask (no rules)', () => {
    expect(evaluateMcp('s', 't', 'ask', [], false)).toBe('prompt')
  })
  it('deny beats allow', () => {
    expect(evaluateMcp('s', 't', 'auto', [R('s.*', 'allow'), R('s.t', 'deny')], false)).toBe(
      'block'
    )
  })
  it('allow → run', () => {
    expect(evaluateMcp('s', 't', 'ask', [R('s.*', 'allow')], false)).toBe('run')
  })
  it('plan mode blocks non-readOnly, allows readOnly (still gated to prompt)', () => {
    expect(evaluateMcp('s', 't', 'plan', [], false)).toBe('block')
    expect(evaluateMcp('s', 't', 'plan', [], true)).toBe('prompt')
    expect(evaluateMcp('s', 't', 'plan', [R('s.*', 'allow')], true)).toBe('run')
    expect(evaluateMcp('s', 't', 'plan', [R('s.t', 'deny')], true)).toBe('block') // deny still wins
  })
})
