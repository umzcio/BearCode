import { describe, it, expect } from 'vitest'
import { evaluateUnsandboxed } from './rules'
import type { PermissionRule } from '../../shared/types'

const r = (match: string, effect: 'allow' | 'deny' | 'ask'): PermissionRule => ({
  id: match,
  scope: 'global',
  action: 'unsandboxed',
  match,
  effect,
  source: 'user'
})

describe('evaluateUnsandboxed', () => {
  it('defaults to prompt (Ask) with no matching rule', () => {
    expect(evaluateUnsandboxed('npm test', [])).toBe('prompt')
  })
  it('allow rule -> run (outside the box)', () => {
    expect(evaluateUnsandboxed('npm test', [r('npm *', 'allow')])).toBe('run')
  })
  it('deny rule -> block (force sandboxed; deny wins over allow)', () => {
    expect(evaluateUnsandboxed('npm test', [r('npm *', 'allow'), r('npm test', 'deny')])).toBe(
      'block'
    )
  })
  it('ask rule -> prompt', () => {
    expect(evaluateUnsandboxed('npm test', [r('npm *', 'ask')])).toBe('prompt')
  })
  it('ignores rules of other actions', () => {
    const cmd: PermissionRule = {
      id: 'c',
      scope: 'global',
      action: 'command',
      match: 'npm *',
      effect: 'allow',
      source: 'user'
    }
    expect(evaluateUnsandboxed('npm test', [cmd])).toBe('prompt')
  })
  it('reuses matchesCommand normalization (collapsed whitespace)', () => {
    expect(evaluateUnsandboxed('npm   test', [r('npm test', 'allow')])).toBe('run')
  })
})
