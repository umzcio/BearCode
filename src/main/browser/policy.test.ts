import { describe, it, expect } from 'vitest'
import { normalizeOrigin, originDecision, matchBrowserTarget, indexOfPageWithToken } from './policy'

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

  // finding 5: a bare-domain entry ('evil.com', no scheme) must still gate.
  it('blocks a bare-domain blocklist entry scheme-agnostically', () => {
    const bare = { allowlist: [], blocklist: ['evil.com'] }
    expect(originDecision('https://evil.com/x', bare)).toBe('block')
    expect(originDecision('http://evil.com/x', bare)).toBe('block')
  })

  // finding 5: entries cover subdomains (host-suffix), both bare and qualified.
  it('blocks subdomains of a blocklisted host', () => {
    expect(
      originDecision('https://www.evil.com/x', { allowlist: [], blocklist: ['evil.com'] })
    ).toBe('block')
    expect(
      originDecision('https://mail.evil.com/x', { allowlist: [], blocklist: ['https://evil.com'] })
    ).toBe('block')
  })

  // finding 5: the dot boundary prevents a look-alike bypass.
  it('does not block a look-alike host that merely ends with the entry text', () => {
    expect(
      originDecision('https://notevil.com/x', { allowlist: [], blocklist: ['evil.com'] })
    ).toBe('allow')
  })

  // finding 5: a bare allowlist entry actually allows (was silently a no-op).
  it('honours a bare-domain allowlist entry and its subdomains', () => {
    const p = { allowlist: ['example.com'], blocklist: [] as string[] }
    expect(originDecision('https://example.com/x', p)).toBe('allow')
    expect(originDecision('http://sub.example.com/x', p)).toBe('allow')
    expect(originDecision('https://other.com/x', p)).toBe('prompt')
  })
})

describe('indexOfPageWithToken', () => {
  // Security-critical: the CDP page is selected by our unique per-session token,
  // NEVER positionally — so the app's own renderer (and any other target) is
  // structurally unreachable.
  const token = '11111111-2222-3333-4444-555555555555'
  it('selects only the page whose url carries the token', () => {
    const urls = [
      'http://localhost:5173/', // the app's OWN renderer
      'file:///app/index.html', // packaged app renderer
      `data:text/html,<!--bearcode-${token}-->`
    ]
    expect(indexOfPageWithToken(urls, token)).toBe(2)
  })
  it('returns -1 when no page carries the token (never falls back to index 0)', () => {
    const urls = ['http://localhost:5173/', 'https://example.com/']
    expect(indexOfPageWithToken(urls, token)).toBe(-1)
  })
  it('returns -1 for an empty token rather than matching everything', () => {
    expect(indexOfPageWithToken(['http://localhost:5173/'], '')).toBe(-1)
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
