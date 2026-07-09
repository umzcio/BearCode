import { describe, it, expect } from 'vitest'
import { evaluateBrowserAction } from './guard'
import type { DomainPolicy } from './policy'

const policy: DomainPolicy = {
  allowlist: ['example.com'],
  blocklist: ['evil.com']
}

describe('evaluateBrowserAction — reads', () => {
  it('always allows reads regardless of mode', () => {
    expect(evaluateBrowserAction({ kind: 'read', mode: 'plan' })).toBe('allow')
    expect(evaluateBrowserAction({ kind: 'read', mode: 'ask' })).toBe('allow')
    expect(evaluateBrowserAction({ kind: 'read', mode: 'auto' })).toBe('allow')
    expect(evaluateBrowserAction({ kind: 'read', mode: 'accept-edits' })).toBe('allow')
    expect(evaluateBrowserAction({ kind: 'read', mode: 'bypass' })).toBe('allow')
  })
})

describe('evaluateBrowserAction — mutate (permission-mode gated)', () => {
  it('blocks mutations in plan mode (read-only)', () => {
    expect(evaluateBrowserAction({ kind: 'mutate', mode: 'plan' })).toBe('block')
  })
  it('prompts for mutations in ask mode', () => {
    expect(evaluateBrowserAction({ kind: 'mutate', mode: 'ask' })).toBe('prompt')
  })
  it('allows mutations in accept-edits, auto, and bypass modes', () => {
    expect(evaluateBrowserAction({ kind: 'mutate', mode: 'accept-edits' })).toBe('allow')
    expect(evaluateBrowserAction({ kind: 'mutate', mode: 'auto' })).toBe('allow')
    expect(evaluateBrowserAction({ kind: 'mutate', mode: 'bypass' })).toBe('allow')
  })
})

describe('evaluateBrowserAction — navigate (domain-policy gated)', () => {
  it('allows an allowlisted origin', () => {
    expect(
      evaluateBrowserAction({
        kind: 'navigate',
        mode: 'auto',
        url: 'https://example.com/x',
        policy
      })
    ).toBe('allow')
  })
  it('prompts for a non-allowlisted origin when an allowlist exists', () => {
    expect(
      evaluateBrowserAction({ kind: 'navigate', mode: 'auto', url: 'https://other.com', policy })
    ).toBe('prompt')
  })
  it('blocks a blocklisted origin', () => {
    expect(
      evaluateBrowserAction({ kind: 'navigate', mode: 'auto', url: 'https://evil.com/x', policy })
    ).toBe('block')
  })
  it('allows anything (except blocklist) when the allowlist is empty', () => {
    const open: DomainPolicy = { allowlist: [], blocklist: ['evil.com'] }
    expect(
      evaluateBrowserAction({
        kind: 'navigate',
        mode: 'auto',
        url: 'https://anything.com',
        policy: open
      })
    ).toBe('allow')
    expect(
      evaluateBrowserAction({
        kind: 'navigate',
        mode: 'auto',
        url: 'https://evil.com',
        policy: open
      })
    ).toBe('block')
  })
  it('defaults to allow-all-but-blocklist when no policy is supplied', () => {
    expect(
      evaluateBrowserAction({ kind: 'navigate', mode: 'auto', url: 'https://anything.com' })
    ).toBe('allow')
  })
  it('ignores permission mode — navigate is read-class, allowed in plan mode within policy', () => {
    expect(
      evaluateBrowserAction({ kind: 'navigate', mode: 'plan', url: 'https://example.com', policy })
    ).toBe('allow')
    // still gated by domain policy even in plan mode
    expect(
      evaluateBrowserAction({ kind: 'navigate', mode: 'plan', url: 'https://evil.com', policy })
    ).toBe('block')
  })
})
