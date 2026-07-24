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

  it('keeps the native platform key separate from the legacy bearer token', async () => {
    const keys = await import('./keys')
    keys.setHermesToken('legacy-token')
    readFileSync.mockReturnValue(
      JSON.stringify(JSON.parse(writeFileSync.mock.calls[0][1] as string))
    )
    keys.setHermesPlatformKey('native-key')
    let written = JSON.parse(writeFileSync.mock.calls[1][1] as string) as Record<string, string>
    expect(written['hermes:bearerToken']).toBeDefined()
    expect(written['hermes:platformKey']).toBeDefined()

    readFileSync.mockReturnValue(JSON.stringify(written))
    keys.setHermesToken('')
    written = JSON.parse(writeFileSync.mock.calls[2][1] as string) as Record<string, string>
    expect(written['hermes:bearerToken']).toBeUndefined()
    expect(written['hermes:platformKey']).toBeDefined()
  })

  it('returns one persisted RFC 4122 installation ID across calls', async () => {
    const keys = await import('./keys')
    const first = keys.getOrCreateHermesInstallationId()
    const written = JSON.parse(writeFileSync.mock.calls[0][1] as string)
    readFileSync.mockReturnValue(JSON.stringify(written))
    const second = keys.getOrCreateHermesInstallationId()
    expect(first).toBe(second)
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
  })
})
