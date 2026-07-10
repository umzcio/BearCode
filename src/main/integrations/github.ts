// GitHub integration: Device Flow + PAT connect, and an authenticated API
// helper for the agent tools (Task 9). Device Flow needs no client secret
// (public client) -- only a registered OAuth App client_id, which is a
// placeholder here (overridable in Settings per the design's open question).
// The PAT path works with zero setup and is the recommended path until a
// real client_id is shipped.
import { loadIntegrationToken } from './store'
import { getSettings } from '../settings'

// Placeholder BearCode GitHub OAuth App client_id -- Device Flow requires a
// real registered client_id to work live; PAT connect needs none. See
// planning/2026-07-09-oauth-integrations-design.md §11.
export const GITHUB_CLIENT_ID = 'Iv1.bearcode-placeholder-client-id'

// The client_id device flow uses: a real BearCode GitHub OAuth App id dropped
// into Settings (githubClientId) overrides the shipped placeholder. Public/
// secret-free (device flow), so it's safe in settings.json. The PAT path needs
// no client_id at all.
function githubClientId(): string {
  return getSettings().githubClientId?.trim() || GITHUB_CLIENT_ID
}

const GITHUB_API_BASE = 'https://api.github.com'

interface GithubDeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

interface GithubTokenResponse {
  error?: string
  error_description?: string
  interval?: number
  access_token?: string
  scope?: string
}

export interface GithubDeviceStart {
  userCode: string
  verificationUri: string
  deviceCode: string
  interval: number
}

export interface GithubConnected {
  token: string
  login: string
  scopes: string[]
}

export async function githubDeviceStart(): Promise<GithubDeviceStart> {
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: githubClientId(), scope: 'repo read:user' })
  })
  if (!res.ok) {
    throw new Error(`GitHub device code request failed (${res.status})`)
  }
  const data = (await res.json()) as GithubDeviceCodeResponse
  return {
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    deviceCode: data.device_code,
    interval: data.interval
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Device codes the renderer has asked to cancel (e.g. the connect modal closed).
// githubDevicePoll checks this each iteration and stops, so a closed modal no
// longer leaves a background poll running until the code expires.
const cancelledDeviceCodes = new Set<string>()
export function cancelGithubDevice(deviceCode: string): void {
  cancelledDeviceCodes.add(deviceCode)
}

async function fetchGithubUser(token: string): Promise<{ login: string; scopes: string[] }> {
  const res = await fetch(`${GITHUB_API_BASE}/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  })
  if (!res.ok) {
    throw new Error(`GitHub token validation failed (${res.status})`)
  }
  const scopesHeader = res.headers.get('x-oauth-scopes') ?? ''
  const scopes = scopesHeader
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const body = (await res.json()) as { login: string }
  return { login: body.login, scopes }
}

/**
 * Polls the device-flow token endpoint until the user approves, denies, or
 * the code expires. Honors `authorization_pending` (keep waiting),
 * `slow_down` (increase the interval), `expired_token` and `access_denied`
 * (throw). Resolves with the token plus the account login/scopes.
 */
export async function githubDevicePoll(
  deviceCode: string,
  interval: number
): Promise<GithubConnected> {
  let currentInterval = Math.max(1, interval)
  let waitMs = currentInterval * 1000
  for (;;) {
    await sleep(waitMs)
    if (cancelledDeviceCodes.has(deviceCode)) {
      cancelledDeviceCodes.delete(deviceCode)
      throw new Error('GitHub sign-in cancelled.')
    }
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: githubClientId(),
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      })
    })
    const data = (await res.json()) as GithubTokenResponse

    if (data.error === 'authorization_pending') continue
    if (data.error === 'slow_down') {
      currentInterval = data.interval ?? currentInterval + 5
      waitMs = currentInterval * 1000
      continue
    }
    if (data.error === 'expired_token') {
      throw new Error('GitHub device code expired -- start sign-in again.')
    }
    if (data.error === 'access_denied') {
      throw new Error('GitHub sign-in was denied.')
    }
    if (data.error) {
      throw new Error(`GitHub device authorization failed: ${data.error}`)
    }
    if (!data.access_token) {
      throw new Error('GitHub device authorization returned no token.')
    }

    const token = data.access_token
    const scopeFromToken = (data.scope ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const { login, scopes } = await fetchGithubUser(token)
    return { token, login, scopes: scopes.length > 0 ? scopes : scopeFromToken }
  }
}

export async function githubConnectPat(
  token: string
): Promise<{ login: string; scopes: string[] }> {
  return fetchGithubUser(token)
}

export async function githubApi(path: string, init: RequestInit = {}): Promise<Response> {
  const stored = loadIntegrationToken<{ token: string }>('github')
  if (!stored?.token) {
    throw new Error('GitHub is not connected. Connect it in Settings -> Integrations.')
  }
  const url = path.startsWith('http') ? path : `${GITHUB_API_BASE}${path}`
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${stored.token}`)
  headers.set('Accept', 'application/vnd.github+json')
  headers.set('X-GitHub-Api-Version', '2022-11-28')
  return fetch(url, { ...init, headers })
}
