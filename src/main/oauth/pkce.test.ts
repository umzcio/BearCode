import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import { generatePkce } from './pkce'

const b64urlOf = (input: Buffer): string => input.toString('base64url')

describe('generatePkce', () => {
  it('produces a URL-safe verifier between 43 and 128 characters', () => {
    const { verifier } = generatePkce()
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(verifier.length).toBeLessThanOrEqual(128)
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('computes challenge as base64url(sha256(verifier))', () => {
    const { verifier, challenge, method } = generatePkce()
    const expected = b64urlOf(createHash('sha256').update(verifier).digest())
    expect(challenge).toBe(expected)
    expect(method).toBe('S256')
  })

  it('generates a different verifier/challenge on each call', () => {
    const a = generatePkce()
    const b = generatePkce()
    expect(a.verifier).not.toBe(b.verifier)
    expect(a.challenge).not.toBe(b.challenge)
  })
})
