import { describe, it, expect } from 'vitest'
import { scrubEnv } from './scrubEnv'

describe('scrubEnv', () => {
  it('keeps the allowlisted base vars', () => {
    const out = scrubEnv({
      PATH: '/usr/bin',
      HOME: '/Users/z',
      LANG: 'en_US.UTF-8',
      TMPDIR: '/tmp/x'
    })
    expect(out.PATH).toBe('/usr/bin')
    expect(out.HOME).toBe('/Users/z')
    expect(out.LANG).toBe('en_US.UTF-8')
    expect(out.TMPDIR).toBe('/tmp/x')
  })

  it('keeps LC_* locale vars', () => {
    const out = scrubEnv({ PATH: '/usr/bin', LC_ALL: 'C', LC_CTYPE: 'UTF-8' })
    expect(out.LC_ALL).toBe('C')
    expect(out.LC_CTYPE).toBe('UTF-8')
  })

  it('drops secret-shaped vars even if not allowlisted', () => {
    const out = scrubEnv({
      PATH: '/usr/bin',
      AWS_ACCESS_KEY_ID: 'AKIA',
      GITHUB_TOKEN: 'ghp_x',
      MY_API_KEY: 'k',
      SOME_SECRET: 's',
      OPENAI_API_KEY: 'sk',
      ANTHROPIC_API_KEY: 'sk-ant',
      GOOGLE_APPLICATION_CREDENTIALS: '/x',
      GH_TOKEN: 'gh'
    })
    expect(out.PATH).toBe('/usr/bin')
    for (const k of [
      'AWS_ACCESS_KEY_ID',
      'GITHUB_TOKEN',
      'MY_API_KEY',
      'SOME_SECRET',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'GH_TOKEN'
    ]) {
      expect(out[k]).toBeUndefined()
    }
  })

  it('drops everything not on the allowlist (default-deny)', () => {
    const out = scrubEnv({ PATH: '/usr/bin', RANDOM_PROJECT_VAR: 'v' })
    expect(out.RANDOM_PROJECT_VAR).toBeUndefined()
  })

  it('drops undefined values', () => {
    const out = scrubEnv({ PATH: '/usr/bin', TERM: undefined })
    expect('TERM' in out).toBe(false)
  })
})
