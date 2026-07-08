import { describe, it, expect } from 'vitest'
import { evaluateCommand, evaluateEdit, BUILTIN_RULES } from './rules'
import type { PermissionMode, PermissionRule } from '../../shared/types'

// Explicit, named regression pins for the security floor F8 must never weaken.
// These duplicate a few assertions elsewhere ON PURPOSE: they are the contract,
// grouped so a future change that loosens them fails loudly and legibly.

const NON_BYPASS_MODES: PermissionMode[] = ['ask', 'accept-edits', 'plan', 'auto']
const rule = (match: string, effect: PermissionRule['effect']): PermissionRule => ({
  id: `t:${match}:${effect}`,
  scope: 'global',
  action: 'command',
  match,
  effect,
  source: 'user'
})

describe('SECURITY FLOOR — deny always wins', () => {
  it('a deny rule beats an allow rule (command)', () => {
    expect(evaluateCommand('git push', 'auto', [rule('git *', 'allow'), rule('git push', 'deny')])).toBe(
      'block'
    )
  })
  it('a deny rule beats terminalAutoExec=auto', () => {
    expect(evaluateCommand('rm -rf /', 'auto', [rule('rm -rf *', 'deny')], 'auto')).toBe('block')
  })
  it('terminalAutoExec can only add a prompt, never remove a deny', () => {
    expect(
      evaluateCommand('rm -rf /', 'auto', [rule('rm -rf *', 'deny')], 'require-review')
    ).toBe('block')
  })
})

describe('SECURITY FLOOR — builtin .env/.git denies hold under every non-bypass mode', () => {
  for (const mode of NON_BYPASS_MODES) {
    it(`.env edit is blocked in ${mode} mode`, () => {
      expect(evaluateEdit('.env', mode, BUILTIN_RULES)).toBe('block')
    })
    it(`.git/config edit is blocked in ${mode} mode`, () => {
      expect(evaluateEdit('.git/config', mode, BUILTIN_RULES)).toBe('block')
    })
    it(`a destructive command is blocked in ${mode} mode`, () => {
      expect(evaluateCommand('rm -rf /', mode, BUILTIN_RULES)).toBe('block')
    })
  }
  it('a user allow rule can NEVER override a builtin .env deny', () => {
    // evaluateEdit has no allow tier at all, so an allow edit rule is inert; the
    // builtin deny still wins.
    const withAllow: PermissionRule[] = [
      ...BUILTIN_RULES,
      { id: 'u', scope: 'global', action: 'edit', match: '.env', effect: 'allow', source: 'user' }
    ]
    expect(evaluateEdit('.env', 'auto', withAllow)).toBe('block')
  })
})

describe('SECURITY FLOOR — plan mode is read-only (outranks allow/ask)', () => {
  it('blocks a command even with an allow rule', () => {
    expect(evaluateCommand('git status', 'plan', [rule('git *', 'allow')])).toBe('block')
  })
  it('blocks an edit even with terminalAutoExec unrelated', () => {
    expect(evaluateEdit('src/a.ts', 'plan', [])).toBe('block')
  })
})

describe('SECURITY FLOOR — terminalAutoExec only tightens the auto fallback', () => {
  it('require-review turns the auto fallback into a prompt', () => {
    expect(evaluateCommand('ls', 'auto', [], 'require-review')).toBe('prompt')
  })
  it('does not upgrade a non-auto mode to run', () => {
    expect(evaluateCommand('ls', 'ask', [], 'auto')).toBe('prompt')
    expect(evaluateCommand('ls', 'accept-edits', [], 'auto')).toBe('prompt')
  })
  it('an explicit allow rule still runs (a deliberate per-command grant)', () => {
    expect(evaluateCommand('git status', 'auto', [rule('git *', 'allow')], 'require-review')).toBe(
      'run'
    )
  })
})
