import { describe, it, expect, vi, beforeEach } from 'vitest'

const readFileSync = vi.fn(() => JSON.stringify({ anthropic: 'enc' }))
const writeFileSync = vi.fn()
vi.mock('fs', () => ({ readFileSync, writeFileSync }))
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: () => Buffer.from('x'),
    decryptString: () => 'plain'
  }
}))

describe('vault read cache', () => {
  beforeEach(() => readFileSync.mockClear())

  it('reads keys.json from disk once across repeated lookups', async () => {
    const keys = await import('./keys')
    keys.getVaultSecret('anthropic')
    keys.getVaultSecret('anthropic')
    keys.keyStatus()
    expect(readFileSync).toHaveBeenCalledTimes(1)
  })

  it('invalidates the cache on write', async () => {
    const keys = await import('./keys')
    keys.getVaultSecret('anthropic') // primes cache (call #1 or reuses from prior test module instance)
    const before = readFileSync.mock.calls.length
    keys.setVaultSecret('openai', 'newval') // writes -> invalidates
    keys.getVaultSecret('anthropic') // must re-read
    expect(readFileSync.mock.calls.length).toBeGreaterThan(before)
  })
})
