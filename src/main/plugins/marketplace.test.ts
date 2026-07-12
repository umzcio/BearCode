import { describe, it, expect } from 'vitest'
import { assertSafeGitUrl } from './marketplace'

describe('assertSafeGitUrl', () => {
  it('accepts https and ssh/git@ URLs', () => {
    expect(() => assertSafeGitUrl('https://github.com/a/b')).not.toThrow()
    expect(() => assertSafeGitUrl('git@github.com:a/b.git')).not.toThrow()
    expect(() => assertSafeGitUrl('ssh://git@host/a/b')).not.toThrow()
  })
  it('rejects RCE-capable transports', () => {
    for (const bad of ['ext::sh -c whoami', 'file:///etc', 'fd::17', '-uarbitrary', 'http://insecure'])
      expect(() => assertSafeGitUrl(bad)).toThrow()
  })
})
