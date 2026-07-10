import { execFileSync } from 'child_process'
import { existsSync, readFileSync, statSync } from 'fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// gitCredentials looks up connection state + token from the store. Mock the
// store so no vault / real credentials are touched.
vi.mock('./store', () => ({
  getIntegration: vi.fn(),
  loadIntegrationToken: vi.fn()
}))

import { getIntegration, loadIntegrationToken } from './store'
import { gitAuthEnv } from './gitCredentials'

const mockGetIntegration = vi.mocked(getIntegration)
const mockLoadToken = vi.mocked(loadIntegrationToken)

function connectGithub(token = 'gho_secrettoken123', login = 'octocat'): void {
  mockGetIntegration.mockImplementation((p) =>
    p === 'github'
      ? { provider: 'github', connected: true, method: 'device', login }
      : { provider: p, connected: false }
  )
  mockLoadToken.mockImplementation((p) => (p === 'github' ? ({ token } as never) : undefined))
}

beforeEach(() => {
  mockGetIntegration.mockReset()
  mockLoadToken.mockReset()
  mockGetIntegration.mockReturnValue({ provider: 'github', connected: false })
  mockLoadToken.mockReturnValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('gitAuthEnv', () => {
  it('injects askpass creds for a github.com HTTPS remote when connected', () => {
    connectGithub()
    const env = gitAuthEnv('https://github.com/octocat/private-repo.git')

    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GIT_ASKPASS).toBeTruthy()
    expect(existsSync(env.GIT_ASKPASS)).toBe(true)
    // token is carried in the process env only, never inside the returned map's script path
    expect(env.BEARCODE_GIT_TOKEN).toBe('gho_secrettoken123')
    expect(env.BEARCODE_GIT_USERNAME).toBeTruthy()
  })

  it('never writes the token into the askpass helper script on disk', () => {
    connectGithub()
    const env = gitAuthEnv('https://github.com/octocat/private-repo.git')
    const script = readFileSync(env.GIT_ASKPASS, 'utf8')
    expect(script).not.toContain('gho_secrettoken123')
    // script reads the secret from the environment instead
    expect(script).toContain('BEARCODE_GIT_TOKEN')
  })

  it('produces an executable askpass helper', () => {
    connectGithub()
    const env = gitAuthEnv('https://github.com/octocat/private-repo.git')
    const mode = statSync(env.GIT_ASKPASS).mode
    // owner-executable bit set
    expect(mode & 0o100).toBe(0o100)
  })

  it('askpass helper returns the token for a password prompt and username for a username prompt', () => {
    connectGithub('gho_livetoken', 'octocat')
    const env = gitAuthEnv('https://github.com/octocat/private-repo.git')
    const runEnv = { ...process.env, ...env }

    const pw = execFileSync(env.GIT_ASKPASS, ["Password for 'https://github.com': "], {
      env: runEnv,
      encoding: 'utf8'
    }).trim()
    expect(pw).toBe('gho_livetoken')

    const user = execFileSync(env.GIT_ASKPASS, ["Username for 'https://github.com': "], {
      env: runEnv,
      encoding: 'utf8'
    }).trim()
    expect(user).toBe('octocat')
  })

  it('injects creds for a bitbucket.org remote when connected', () => {
    mockGetIntegration.mockImplementation((p) =>
      p === 'bitbucket'
        ? { provider: 'bitbucket', connected: true, method: 'app-password', login: 'bbuser' }
        : { provider: p, connected: false }
    )
    mockLoadToken.mockImplementation((p) =>
      p === 'bitbucket' ? ({ token: 'app-pass-xyz' } as never) : undefined
    )
    const env = gitAuthEnv('https://bitbucket.org/team/repo.git')
    expect(env.GIT_ASKPASS).toBeTruthy()
    expect(env.BEARCODE_GIT_TOKEN).toBe('app-pass-xyz')
    expect(env.BEARCODE_GIT_USERNAME).toBe('bbuser')
  })

  it('returns {} for an unmatched host', () => {
    connectGithub()
    expect(gitAuthEnv('https://gitlab.com/foo/bar.git')).toEqual({})
  })

  it('returns {} when the matching provider is not connected', () => {
    mockGetIntegration.mockReturnValue({ provider: 'github', connected: false })
    mockLoadToken.mockReturnValue(undefined)
    expect(gitAuthEnv('https://github.com/foo/bar.git')).toEqual({})
  })

  it('returns {} when connected but no token is present in the vault', () => {
    mockGetIntegration.mockImplementation((p) => ({ provider: p, connected: p === 'github' }))
    mockLoadToken.mockReturnValue(undefined)
    expect(gitAuthEnv('https://github.com/foo/bar.git')).toEqual({})
  })

  it('returns {} for an SSH scp-style remote (askpass is HTTPS-only)', () => {
    connectGithub()
    expect(gitAuthEnv('git@github.com:octocat/repo.git')).toEqual({})
  })

  it('returns {} for an unparseable remote', () => {
    connectGithub()
    expect(gitAuthEnv('not a url')).toEqual({})
  })
})
