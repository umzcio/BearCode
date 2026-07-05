// safeStorage key vault. Keys live encrypted at rest in userData/keys.json,
// are decrypted only in main-process memory, and are never sent to the
// renderer or written to logs.
import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ProviderId } from '../shared/types'

const PROVIDERS: ProviderId[] = ['anthropic', 'openai', 'google', 'openrouter', 'ollama']

function vaultPath(): string {
  return join(app.getPath('userData'), 'keys.json')
}

function readVault(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(vaultPath(), 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}

function writeVault(vault: Record<string, string>): void {
  writeFileSync(vaultPath(), JSON.stringify(vault, null, 2), { mode: 0o600 })
}

export function setKey(provider: ProviderId, key: string): void {
  const vault = readVault()
  if (!key) {
    delete vault[provider]
  } else if (safeStorage.isEncryptionAvailable()) {
    vault[provider] = safeStorage.encryptString(key).toString('base64')
  } else {
    throw new Error('safeStorage encryption is not available on this system')
  }
  writeVault(vault)
}

export function getKey(provider: ProviderId): string | undefined {
  const stored = readVault()[provider]
  if (!stored) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch (err) {
    console.error(`[bearcode] failed to decrypt key for ${provider}:`, err)
    return undefined
  }
}

export function keyStatus(): Record<ProviderId, boolean> {
  const vault = readVault()
  const status = {} as Record<ProviderId, boolean>
  for (const p of PROVIDERS) status[p] = Boolean(vault[p])
  return status
}
