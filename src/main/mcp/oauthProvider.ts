// Vault-backed OAuthClientProvider for MCP servers.
//
// The MCP SDK (`@modelcontextprotocol/sdk/client/auth.js`) drives the whole
// OAuth spec (RFC 9728 discovery → RFC 7591 dynamic client registration →
// PKCE → token exchange/refresh). We only implement the storage + user-agent
// side of the `OAuthClientProvider` interface, backed by:
//   - the encrypted vault (keys.ts, via oauth/credentials) for client info + tokens
//   - a loopback HTTP server (oauth/loopback) to capture the redirect
//   - the system browser (oauth/browser) to present the sign-in page
//
// SECURITY: tokens/client secrets live only in the vault; they are never logged
// and never cross IPC. The loopback server binds 127.0.0.1 only (see loopback.ts).
//
// NOTE (deviation from the design doc): the design said `redirectUrl` would be
// created "lazily on redirectToAuthorization". The installed SDK actually reads
// `provider.redirectUrl` BEFORE the redirect (auth.js: an undefined redirectUrl
// is treated as a non-interactive flow, and `clientMetadata.redirect_uris` is
// consumed during dynamic client registration, both before any redirect). So we
// expose `prepare()` to start the loopback capture up front; the manager (Task 5)
// awaits it before calling the SDK's `auth()`. Verified against
// node_modules/@modelcontextprotocol/sdk/dist/esm/client/auth.js (authInternal).
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientMetadata,
  OAuthClientInformationMixed,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { startLoopbackCapture, type LoopbackCapture } from '../oauth/loopback'
import { openSignIn } from '../oauth/browser'
import { saveOAuth, loadOAuth, clearOAuth } from '../oauth/credentials'

/**
 * The SDK `OAuthClientProvider` plus the small extra surface the MCP manager
 * needs to drive the two-step `auth()` flow (prepare the loopback, then read
 * the captured code back for the continuation call).
 */
export interface McpOAuthProvider extends OAuthClientProvider {
  /**
   * Starts the loopback capture so `redirectUrl` and `clientMetadata` are
   * populated before the SDK's `auth()` runs. Idempotent — one loopback server
   * per provider instance.
   */
  prepare(): Promise<void>
  /**
   * Returns the authorization code captured by `redirectToAuthorization`,
   * consuming it (a second call returns undefined). The manager hands this to
   * the SDK's `auth(serverUrl, { authorizationCode })` continuation.
   */
  takeAuthorizationCode(): string | undefined
  /** Tears down any in-flight loopback capture. Safe to call multiple times. */
  dispose(): void
}

export function makeMcpOAuthProvider(serverName: string): McpOAuthProvider {
  const clientKey = `oauth:mcp:${serverName}:client`
  const tokensKey = `oauth:mcp:${serverName}:tokens`

  // In-memory, session-scoped state (never persisted).
  let codeVerifierMem: string | undefined
  let capture: LoopbackCapture | undefined
  let redirectUri: string | undefined
  let capturedCode: string | undefined

  async function ensurePrepared(): Promise<void> {
    if (capture) return
    capture = await startLoopbackCapture()
    redirectUri = capture.redirectUri
  }

  return {
    get redirectUrl(): string | undefined {
      return redirectUri
    },

    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: 'BearCode',
        redirect_uris: redirectUri ? [redirectUri] : [],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        // Public client (loopback + PKCE, no shipped secret).
        token_endpoint_auth_method: 'none'
      }
    },

    clientInformation(): OAuthClientInformationMixed | undefined {
      return loadOAuth<OAuthClientInformationMixed>(clientKey)
    },

    saveClientInformation(info: OAuthClientInformationMixed): void {
      saveOAuth(clientKey, info)
    },

    tokens(): OAuthTokens | undefined {
      return loadOAuth<OAuthTokens>(tokensKey)
    },

    saveTokens(tokens: OAuthTokens): void {
      saveOAuth(tokensKey, tokens)
    },

    saveCodeVerifier(verifier: string): void {
      codeVerifierMem = verifier
    },

    codeVerifier(): string {
      if (!codeVerifierMem) {
        throw new Error(`No PKCE code verifier for MCP OAuth session "${serverName}"`)
      }
      return codeVerifierMem
    },

    async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
      await ensurePrepared()
      // capture is guaranteed non-undefined after ensurePrepared().
      const active = capture!
      // Open the sign-in page in the system browser (never an embedded webview).
      await openSignIn(authorizationUrl.toString())
      // Block until the user completes sign-in and the IdP redirects to our
      // loopback callback (the server auto-closes once it fires).
      const params = await active.wait()
      capture = undefined
      const err = params.get('error')
      if (err) {
        const desc = params.get('error_description')
        throw new Error(`OAuth authorization failed: ${err}${desc ? ` (${desc})` : ''}`)
      }
      const code = params.get('code')
      if (!code) {
        throw new Error('OAuth authorization failed: no code in redirect')
      }
      capturedCode = code
    },

    takeAuthorizationCode(): string | undefined {
      const code = capturedCode
      capturedCode = undefined
      return code
    },

    invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
      if (scope === 'all' || scope === 'client') clearOAuth(clientKey)
      if (scope === 'all' || scope === 'tokens') clearOAuth(tokensKey)
      if (scope === 'all' || scope === 'verifier') codeVerifierMem = undefined
      // 'discovery' is a no-op: we don't persist discovery state.
    },

    async prepare(): Promise<void> {
      await ensurePrepared()
    },

    dispose(): void {
      capture?.close()
      capture = undefined
    }
  }
}
