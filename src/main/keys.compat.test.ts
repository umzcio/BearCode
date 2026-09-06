import { describe, it, expect, vi, beforeEach } from 'vitest'

// Same vault-mock idiom as keys.cache.test.ts: an in-memory keys.json so the
// vault read/write path is exercised without touching a real disk. ./keys is
// imported lazily (await import) so the hoisted mock factories can reference
// these consts safely.
let store: Record<string, string> = {}
const readFileSync = vi.fn(() => JSON.stringify(store))
const writeFileSync = vi.fn((_path: string, data: string) => {
  store = JSON.parse(data) as Record<string, string>
})
vi.mock('fs', () => ({ readFileSync, writeFileSync }))
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (v: string) => Buffer.from(`enc:${v}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, '')
  }
}))

const CONFIGURED = ['vllm', 'lm-studio']

describe('compat endpoint keys (keys.ts)', () => {
  beforeEach(() => {
    store = {}
    readFileSync.mockClear()
    writeFileSync.mockClear()
  })

  it('namespaces vault keys as compat:<endpointId>', async () => {
    const keys = await import('./keys')
    expect(keys.compatVaultKey('vllm')).toBe('compat:vllm')
  })

  it('set + get round-trips a key for a configured endpoint', async () => {
    const keys = await import('./keys')
    keys.setCompatKey('vllm', 'sekret', CONFIGURED)
    expect(keys.getCompatKey('vllm')).toBe('sekret')
    expect(store['compat:vllm']).toBe(Buffer.from('enc:sekret').toString('base64'))
  })

  it('an empty value clears the stored key (vault delete convention)', async () => {
    const keys = await import('./keys')
    keys.setCompatKey('vllm', 'sekret', CONFIGURED)
    keys.setCompatKey('vllm', '', CONFIGURED)
    expect(keys.getCompatKey('vllm')).toBeUndefined()
    expect('compat:vllm' in store).toBe(false)
  })

  it('rejects an endpoint id that is not configured, without touching the vault', async () => {
    const keys = await import('./keys')
    const writesBefore = writeFileSync.mock.calls.length
    expect(() => keys.setCompatKey('nope', 'sekret', CONFIGURED)).toThrow(
      /unknown compat endpoint/i
    )
    expect(writeFileSync.mock.calls.length).toBe(writesBefore)
    expect(store['compat:nope']).toBeUndefined()
  })

  it('compatKeyStatus reports booleans only, for exactly the configured endpoints', async () => {
    const keys = await import('./keys')
    keys.setCompatKey('vllm', 'sekret', CONFIGURED)
    expect(keys.compatKeyStatus(CONFIGURED)).toEqual({ vllm: true, 'lm-studio': false })
    // An unconfigured id never appears, even if a vault entry exists for it.
    expect(keys.compatKeyStatus(['vllm'])).toEqual({ vllm: true })
  })

  it('keyStatus() stays a complete Record<ProviderId, boolean> with compat always false', async () => {
    const keys = await import('./keys')
    keys.setCompatKey('vllm', 'sekret', CONFIGURED)
    expect(keys.keyStatus()).toEqual({
      anthropic: false,
      openai: false,
      google: false,
      openrouter: false,
      perplexity: false,
      xai: false,
      ollama: false,
      // Per-endpoint keys live under compat:<id>, never the bare 'compat' key.
      compat: false
    })
  })
})
