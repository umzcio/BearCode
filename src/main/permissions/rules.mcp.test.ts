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
