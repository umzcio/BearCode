import { execFile } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'

// Credential resolver registered by the integrations layer (see ipc.ts →
// integrations/gitCredentials.gitAuthEnv). Given a remote HTTPS URL it returns
// the GIT_ASKPASS env for a *connected* integration, or `{}` for anything
// else. Injected as a hook rather than imported directly so this low-level
// runner carries no dependency on the vault/electron layer and stays unit-
// testable in isolation (and so there is no worktree→integrations import cycle).
let credentialResolver: ((remoteUrl: string) => Record<string, string>) | null = null
export function setGitCredentialResolver(
  fn: ((remoteUrl: string) => Record<string, string>) | null
): void {
  credentialResolver = fn
}

// git subcommands that talk to a remote over the network. Only these get
// automatic credential injection; every other op (add/commit/merge/worktree/…)
// is purely local and runs with the unmodified parent env.
const REMOTE_SUBCOMMANDS = new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote'])

function firstHttpUrl(args: string[]): string | undefined {
  return args.find((a) => /^https?:\/\//i.test(a))
}

// Resolves the remote HTTPS URL a network subcommand targets so the credential
// resolver can match it to an integration. `clone`/explicit-URL forms carry the
// URL inline; `fetch`/`pull`/`push` without a URL resolve the configured
// remote's URL via a *local* `git remote get-url` (never recurses into the
// resolver — 'remote' is not a REMOTE_SUBCOMMAND).
async function remoteAuthEnv(
  args: string[],
  cwd: string,
  resolve: (remoteUrl: string) => Record<string, string>
): Promise<Record<string, string>> {
  const sub = args[0]
  if (!REMOTE_SUBCOMMANDS.has(sub)) return {}
  let url = firstHttpUrl(args.slice(1))
  if (!url && sub !== 'clone') {
    const remoteName = args.slice(1).find((a) => !a.startsWith('-')) ?? 'origin'
    try {
      url = (await git(['remote', 'get-url', remoteName], cwd)).stdout.trim()
    } catch {
      return {}
    }
  }
  if (!url) return {}
  return resolve(url)
}

// `env` (optional) is merged over the parent process env for this invocation
// only — the integrations layer injects GIT_ASKPASS credentials for private
// HTTPS remotes (see integrations/gitCredentials.ts). Never written to disk
// config; scoped to the single child process. When no explicit `env` is given
// and the subcommand is a network op, the registered credential resolver is
// consulted so a private-repo clone/fetch/pull/push authenticates transparently.
export async function git(
  args: string[],
  cwd: string,
  env?: Record<string, string>
): Promise<{ stdout: string; stderr: string }> {
  let effectiveEnv = env
  if (!effectiveEnv && credentialResolver && REMOTE_SUBCOMMANDS.has(args[0])) {
    const auth = await remoteAuthEnv(args, cwd, credentialResolver)
    if (Object.keys(auth).length > 0) effectiveEnv = auth
  }
  return new Promise((resolve, reject) => {
    const options = {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      env: effectiveEnv ? { ...process.env, ...effectiveEnv } : process.env
    }
    execFile('git', args, options, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`git ${args.join(' ')} failed: ${stderr || err.message}`))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

export function gitAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('git', ['--version'], (err) => resolve(!err))
  })
}

export function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'))
}

// A repo is the project folder itself (if it is a repo) plus any IMMEDIATE
// subdirectory that is a repo. Deeper/nested repos + submodules are ignored
// (locked scope). Returns absolute paths.
export function discoverRepos(projectPath: string): string[] {
  const repos: string[] = []
  if (isGitRepo(projectPath)) repos.push(projectPath)
  let entries: import('fs').Dirent[] = []
  try {
    entries = readdirSync(projectPath, { withFileTypes: true })
  } catch {
    return repos
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === '.git') continue
    const child = join(projectPath, e.name)
    if (isGitRepo(child)) repos.push(child)
  }
  return repos
}
