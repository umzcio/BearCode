// Integrations connection state + token storage. Connection metadata
// (connected?, method, login, scopes, connectedAt) and the auth token are
// both kept in the encrypted vault, under separate namespaces, via the
// shared oauth/credentials helpers -- never on disk in plaintext, never
// sent to the renderer. IPC (Task 11) will only ever expose the status
// booleans/login from IntegrationState, not the token.
import { saveOAuth, loadOAuth, clearOAuth } from '../oauth/credentials'

export type IntegrationProvider = 'github' | 'bitbucket'

export interface IntegrationState {
  provider: IntegrationProvider
  connected: boolean
  method?: 'device' | 'pat' | 'app-password'
  login?: string
  scopes?: string[]
  connectedAt?: number
}

const stateNs = (provider: IntegrationProvider): string => `oauth:${provider}:state`
const tokenNs = (provider: IntegrationProvider): string => `oauth:${provider}:token`

export function getIntegration(provider: IntegrationProvider): IntegrationState {
  return loadOAuth<IntegrationState>(stateNs(provider)) ?? { provider, connected: false }
}

export function setIntegration(provider: IntegrationProvider, state: IntegrationState): void {
  saveOAuth(stateNs(provider), state)
}

export function disconnect(provider: IntegrationProvider): void {
  clearOAuth(stateNs(provider))
  clearOAuth(tokenNs(provider))
}

// Token storage is intentionally separate from IntegrationState so a future
// IPC status call can return the state object wholesale without ever
// touching (or risking leaking) the token.
export function saveIntegrationToken<T>(provider: IntegrationProvider, token: T): void {
  saveOAuth(tokenNs(provider), token)
}

export function loadIntegrationToken<T>(provider: IntegrationProvider): T | undefined {
  return loadOAuth<T>(tokenNs(provider))
}
