import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the child_process spawn so no real `git` (or network) runs: we only need
// to observe WHICH env the runner hands the child and WHETHER the credential
// resolver was consulted for a given subcommand.
type ExecCb = (err: Error | null, stdout: string, stderr: string) => void
const execFileMock = vi.fn()
vi.mock('child_process', () => ({
  execFile: (...a: unknown[]) => execFileMock(...a)
}))

const { git, setGitCredentialResolver } = await import('./git')

// Default: every git invocation "succeeds" with empty output. Individual tests
// override to answer a `remote get-url` lookup.
function stubGitOk(): void {
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) => {
    cb(null, '', '')
  })
}

function lastOptions(): { env: NodeJS.ProcessEnv } {
  return execFileMock.mock.calls.at(-1)![2] as { env: NodeJS.ProcessEnv }
}

describe('git() credential injection', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    setGitCredentialResolver(null)
  })
  afterEach(() => {
    setGitCredentialResolver(null)
  })

  it('does NOT consult the resolver for a local subcommand and leaves env untouched', async () => {
    stubGitOk()
    const resolver = vi.fn(() => ({ GIT_ASKPASS: '/should-not-be-used' }))
    setGitCredentialResolver(resolver)

    await git(['status', '--porcelain'], '/repo')

    expect(resolver).not.toHaveBeenCalled()
    // No explicit env + no injection → the plain parent env is passed through.
    expect(lastOptions().env).toBe(process.env)
  })

  it('consults the resolver with the inline URL for clone and injects its env', async () => {
    stubGitOk()
    const resolver = vi.fn(() => ({ GIT_ASKPASS: '/helper.sh', BEARCODE_GIT_TOKEN: 'tok' }))
    setGitCredentialResolver(resolver)

    await git(['clone', 'https://github.com/octocat/private.git', '/dest'], '/cwd')

    expect(resolver).toHaveBeenCalledWith('https://github.com/octocat/private.git')
    const env = lastOptions().env
    expect(env.GIT_ASKPASS).toBe('/helper.sh')
    expect(env.BEARCODE_GIT_TOKEN).toBe('tok')
  })

  it('resolves the configured remote URL for push and injects credentials', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: ExecCb) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        cb(null, 'https://github.com/octocat/private.git\n', '')
        return
      }
      cb(null, '', '')
    })
    const resolver = vi.fn(() => ({ GIT_ASKPASS: '/helper.sh' }))
    setGitCredentialResolver(resolver)

    await git(['push', 'origin', 'main'], '/cwd')

    expect(resolver).toHaveBeenCalledWith('https://github.com/octocat/private.git')
    // The push (last call) carries the injected helper; the get-url lookup that
    // resolved the URL ran as a plain local op.
    expect(lastOptions().env.GIT_ASKPASS).toBe('/helper.sh')
  })

  it('leaves env untouched when the resolver returns {} (unconnected/unknown host)', async () => {
    stubGitOk()
    const resolver = vi.fn(() => ({}))
    setGitCredentialResolver(resolver)

    await git(['fetch', 'https://gitlab.com/x/y.git'], '/cwd')

    expect(resolver).toHaveBeenCalledWith('https://gitlab.com/x/y.git')
    expect(lastOptions().env).toBe(process.env)
  })

  it('does not inject or consult the resolver when the caller passes explicit env', async () => {
    stubGitOk()
    const resolver = vi.fn(() => ({ GIT_ASKPASS: '/from-resolver' }))
    setGitCredentialResolver(resolver)

    await git(['fetch', 'https://github.com/o/r.git'], '/cwd', { GIT_ASKPASS: '/explicit' })

    expect(resolver).not.toHaveBeenCalled()
    expect(lastOptions().env.GIT_ASKPASS).toBe('/explicit')
  })
})
