// git-over-HTTPS credential injection for the F3 worktree/git runner.
//
// When a git command targets a host that maps to a *connected* integration
// (github.com -> GitHub, bitbucket.org -> Bitbucket), we hand git a per-
// invocation credential via a GIT_ASKPASS helper script. The token itself is
// passed ONLY through the child process environment (BEARCODE_GIT_TOKEN); it is
// never written into `.git/config` and never baked into the helper script on
// disk. GIT_TERMINAL_PROMPT=0 makes an unauthenticated/failed op fail fast
// instead of hanging on an interactive prompt.
//
// Mechanism choice (verified against git docs + the F3 runner seam in
// worktree/git.ts, which is `execFile('git', args, { cwd, maxBuffer })` with no
// env): GIT_ASKPASS is env-only, so it slots into a widened `env` option on the
// runner without touching argv or on-disk config. The helper reads the secret
// from its own environment at call time, so the file it lives in contains no
// secret and is safe to persist.
import { chmodSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getIntegration, loadIntegrationToken, type IntegrationProvider } from './store'

// host -> provider. Only exact HTTPS hosts we support; anything else passes
// through unauthenticated.
const HOST_PROVIDER: Record<string, IntegrationProvider> = {
  'github.com': 'github',
  'www.github.com': 'github',
  'bitbucket.org': 'bitbucket'
}

// POSIX sh askpass helper. Contains NO secret: it echoes the username for a
// "Username" prompt and the token for anything else, reading both from the
// environment git passes down. git invokes it as `askpass "<prompt>"` and reads
// the credential from stdout.
const ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  Username*|username*) printf '%s' "$BEARCODE_GIT_USERNAME" ;;
  *) printf '%s' "$BEARCODE_GIT_TOKEN" ;;
esac
`

let cachedAskpassPath: string | undefined

// Writes the (secret-free) askpass helper into a per-process private directory
// (0700, random name via mkdtemp), once. Using mkdtemp — not a predictable path
// in the shared temp dir — means a local attacker cannot pre-create or tamper
// with the helper git will execute (the old stable path + skip-if-exists let a
// planted script survive and run with BEARCODE_GIT_TOKEN in its env). Returns
// the absolute path.
function ensureAskpassScript(): string {
  if (cachedAskpassPath) return cachedAskpassPath
  const dir = mkdtempSync(join(tmpdir(), 'bearcode-git-'))
  const path = join(dir, 'askpass.sh')
  writeFileSync(path, ASKPASS_SCRIPT, { mode: 0o700 })
  chmodSync(path, 0o700)
  cachedAskpassPath = path
  return path
}

function hostOf(remoteUrl: string): string | undefined {
  // Only HTTPS(-style) URLs get askpass creds; scp-style (git@host:path) and
  // ssh:// are handled by the user's SSH agent, not us.
  try {
    const u = new URL(remoteUrl)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined
    return u.hostname.toLowerCase()
  } catch {
    return undefined
  }
}

/**
 * Returns environment variables to inject into a git child process so it can
 * authenticate to a private HTTPS remote, or `{}` when the remote host has no
 * connected integration (git then behaves exactly as before).
 *
 * Never logs the token, never writes it to disk config. The returned map is
 * merged into the git runner's `env` for that single invocation only.
 */
export function gitAuthEnv(remoteUrl: string): Record<string, string> {
  const host = hostOf(remoteUrl)
  if (!host) return {}

  const provider = HOST_PROVIDER[host]
  if (!provider) return {}

  const state = getIntegration(provider)
  if (!state.connected) return {}

  const stored = loadIntegrationToken<{ token: string }>(provider)
  if (!stored?.token) return {}

  // Username: git wants a non-empty username for token auth. GitHub accepts any
  // value (fall back to a sentinel); Bitbucket app-passwords require the real
  // account username, so use the stored login when present.
  const username = state.login ?? (provider === 'github' ? 'x-access-token' : '')

  return {
    GIT_ASKPASS: ensureAskpassScript(),
    GIT_TERMINAL_PROMPT: '0',
    BEARCODE_GIT_USERNAME: username,
    BEARCODE_GIT_TOKEN: stored.token
  }
}
