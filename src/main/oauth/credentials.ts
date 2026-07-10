// Thin vault-namespacing helpers for OAuth/integration credentials. Secrets
// are JSON-encoded and stored via the encrypted vault (keys.ts); they never
// touch disk in plaintext and are never sent to the renderer.
import { setVaultSecret, getVaultSecret } from '../keys'

export function saveOAuth(ns: string, data: unknown): void {
  setVaultSecret(ns, JSON.stringify(data))
}

export function loadOAuth<T>(ns: string): T | undefined {
  const raw = getVaultSecret(ns)
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    // Log the namespace only — a JSON SyntaxError message can embed a snippet
    // of the decrypted raw value, which must never reach logs.
    console.error(`[bearcode] failed to parse vault credential for ${ns} (malformed JSON)`)
    return undefined
  }
}

export function clearOAuth(ns: string): void {
  setVaultSecret(ns, '')
}
