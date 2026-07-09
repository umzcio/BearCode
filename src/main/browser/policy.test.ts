import { describe, it, expect } from 'vitest'
import { normalizeOrigin, originDecision, matchBrowserTarget } from './policy'

describe('normalizeOrigin', () => {
  it('extracts scheme://host:port', () => {
    expect(normalizeOrigin('https://Example.com/a/b?x=1')).toBe('https://example.com')
    expect(normalizeOrigin('http://localhost:5173/x')).toBe('http://localhost:5173')
    expect(normalizeOrigin('not a url')).toBeNull()
  })
})

describe('originDecision', () => {
  const p = { allowlist: ['https://example.com'], blocklist: ['https://evil.com'] }
  it('blocks blocklisted', () => {
    expect(originDecision('https://evil.com/x', p)).toBe('block')
  })
  it('allows allowlisted', () => {
    expect(originDecision('https://example.com/x', p)).toBe('allow')
  })
  it('prompts for anything else when an allowlist exists', () => {
    expect(originDecision('https://other.com', p)).toBe('prompt')
  })
  it('allows anything (except blocklist) when the allowlist is empty', () => {
    expect(
      originDecision('https://anything.com', { allowlist: [], blocklist: ['https://evil.com'] })
    ).toBe('allow')
    expect(
      originDecision('https://evil.com', { allowlist: [], blocklist: ['https://evil.com'] })
    ).toBe('block')
  })
})

describe('matchBrowserTarget', () => {
  const targets = [
    { url: 'http://localhost:5173/', type: 'page', id: 'app' }, // the app's OWN renderer — must NOT match
    { url: 'https://example.com/', type: 'page', id: 'view' }
  ]
  it('selects the view target by url, never the app renderer', () => {
    expect(matchBrowserTarget(targets, 'https://example.com/')?.id).toBe('view')
  })
  it('returns null when nothing matches', () => {
    expect(matchBrowserTarget(targets, 'https://nope.com/')).toBeNull()
  })
})
