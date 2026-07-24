import { describe, it, expect, vi, beforeEach } from 'vitest'

const readFileSync = vi.fn(() => JSON.stringify({}))
const writeFileSync = vi.fn()
vi.mock('fs', () => ({ readFileSync, writeFileSync }))
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}))

describe('hermes token vault helpers', () => {
  beforeEach(() => {
    vi.resetModules()
    readFileSync.mockReset()
    readFileSync.mockImplementation(() => JSON.stringify({}))
    writeFileSync.mockClear()
  })

  it('setHermesToken then getHermesToken round-trips through the vault', async () => {
    const keys = await import('./keys')
    keys.setHermesToken('secret-token-value')
    const written = JSON.parse(writeFileSync.mock.calls[0][1] as string) as Record<string, string>
    expect(written['hermes:bearerToken']).toBeDefined()
    readFileSync.mockReturnValue(JSON.stringify(written))
    expect(keys.getHermesToken()).toBe('secret-token-value')
  })

  it('getHermesToken returns undefined when nothing is stored', async () => {
    const keys = await import('./keys')
    expect(keys.getHermesToken()).toBeUndefined()
  })
})
