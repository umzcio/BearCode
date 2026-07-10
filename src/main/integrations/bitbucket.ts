// Bitbucket integration: App Password connect (Basic auth), and an
// authenticated API helper for the agent tools (Task 10). Bitbucket Cloud has
// no equivalent to GitHub's client-secret-free Device Flow for a shipped OSS
// binary, so App Passwords (username + app password, validated via
// GET /2.0/user) are the only supported path for now; a real OAuth-code
// client is deferred (design §11).
//
// Verified against Bitbucket Cloud REST API v2 docs (developer.atlassian.com
// api-group-pullrequests / api-group-repositories, July 2026):
//   - Base URL: https://api.bitbucket.org/2.0
//   - Auth: HTTP Basic (username:app_password), validated via GET /2.0/user
//   - List repos: GET /2.0/repositories/{workspace}?role=member
//   - Create PR: POST /2.0/repositories/{workspace}/{repo_slug}/pullrequests
//     body { title, source: { branch: { name } }, destination: { branch: { name } }, description? }
import { getIntegration, loadIntegrationToken } from './store'

const BITBUCKET_API_BASE = 'https://api.bitbucket.org/2.0'

function basicAuthHeader(username: string, appPassword: string): string {
  return `Basic ${Buffer.from(`${username}:${appPassword}`).toString('base64')}`
}

export interface BitbucketConnected {
  username: string
}

/**
 * Validates a username + app password pair via GET /2.0/user (Basic auth).
 * Returns the account's canonical username (Bitbucket may normalize casing),
 * falling back to the entered username if the response omits it.
 */
export async function bitbucketConnect(
  username: string,
  appPassword: string
): Promise<BitbucketConnected> {
  const res = await fetch(`${BITBUCKET_API_BASE}/user`, {
    headers: {
      Authorization: basicAuthHeader(username, appPassword),
      Accept: 'application/json'
    }
  })
  if (!res.ok) {
    throw new Error(`Bitbucket app password validation failed (${res.status})`)
  }
  const body = (await res.json()) as { username?: string }
  return { username: body.username ?? username }
}

/**
 * Authenticated Bitbucket Cloud API call. Reads the stored app password (kept
 * under the same generic `{ token }` shape as GitHub/gitCredentials) and the
 * connected account's username (state.login, per store.ts/gitCredentials.ts),
 * and sends Basic auth. Throws an actionable error if Bitbucket is not
 * connected -- the app password never leaves the main process.
 */
export async function bitbucketApi(path: string, init: RequestInit = {}): Promise<Response> {
  const state = getIntegration('bitbucket')
  const stored = loadIntegrationToken<{ token: string }>('bitbucket')
  if (!state.connected || !stored?.token || !state.login) {
    throw new Error('Bitbucket is not connected. Connect it in Settings -> Integrations.')
  }
  const url = path.startsWith('http') ? path : `${BITBUCKET_API_BASE}${path}`
  const headers = new Headers(init.headers)
  headers.set('Authorization', basicAuthHeader(state.login, stored.token))
  headers.set('Accept', 'application/json')
  return fetch(url, { ...init, headers })
}
