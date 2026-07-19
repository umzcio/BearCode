// safeStorage key vault. Keys live encrypted at rest in userData/keys.json,
// are decrypted only in main-process memory, and are never sent to the
// renderer or written to logs.
import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ProviderId } from '../shared/types'

const PROVIDERS: ProviderId[] = [
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'perplexity',
  'xai',
  'ollama'
]

function vaultPath(): string {
  return join(app.getPath('userData'), 'keys.json')
}

let vaultCache: Record<string, string> | null = null

function readVault(): Record<string, string> {
  if (vaultCache) return vaultCache
  try {
    vaultCache = JSON.parse(readFileSync(vaultPath(), 'utf8')) as Record<string, string>
  } catch {
    vaultCache = {}
  }
  return vaultCache
}

function writeVault(vault: Record<string, string>): void {
  writeFileSync(vaultPath(), JSON.stringify(vault, null, 2), { mode: 0o600 })
  vaultCache = null // invalidate so the next read reflects what's on disk
}

export function setVaultSecret(key: string, value: string): void {
  const vault = readVault()
  if (!value) {
    delete vault[key]
  } else if (safeStorage.isEncryptionAvailable()) {
    vault[key] = safeStorage.encryptString(value).toString('base64')
  } else {
    throw new Error('safeStorage encryption is not available on this system')
  }
  writeVault(vault)
}

export function getVaultSecret(key: string): string | undefined {
  const stored = readVault()[key]
  if (!stored) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch (err) {
    console.error(`[bearcode] failed to decrypt vault secret for ${key}:`, err)
    return undefined
  }
}

export function setKey(provider: ProviderId, key: string): void {
  setVaultSecret(provider, key)
}

export function getKey(provider: ProviderId): string | undefined {
  return getVaultSecret(provider)
}

// Replaces ${VAULT:key} references in a string with the decrypted secret,
// or '' if the key isn't in the vault. Used to resolve MCP server configs
// (headers/env) without ever storing plaintext secrets in mcp.json.
const VAULT_REF = /\$\{VAULT:([^}]+)\}/g
export function resolveVaultRefs(input: string): string {
  return input.replace(VAULT_REF, (_m, k: string) => getVaultSecret(k) ?? '')
}

export function keyStatus(): Record<ProviderId, boolean> {
  const vault = readVault()
  const status = {} as Record<ProviderId, boolean>
  for (const p of PROVIDERS) status[p] = Boolean(vault[p])
  return status
}
