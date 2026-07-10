import { describe, it, expect, vi, beforeEach } from 'vitest'

// Minimal in-memory mock of electron's safeStorage + app.getPath, mirroring
// the pattern used by settings.browser.test.ts (mock 'electron' directly).
// The vault file itself is mocked via an in-memory Record so no real fs I/O
// touches disk during the test run.
const fakeVaultFiles = new Map<string, string>()

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/fake-user-data') },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`)),
    decryptString: vi.fn((buf: Buffer) => buf.toString('utf8').replace(/^enc:/, ''))
  }
}))

vi.mock('fs', () => ({
  readFileSync: vi.fn((path: string) => {
    const contents = fakeVaultFiles.get(path)
    if (contents === undefined) throw new Error('ENOENT')
    return contents
  }),
  writeFileSync: vi.fn((path: string, contents: string) => {
    fakeVaultFiles.set(path, contents)
  })
}))

import { setVaultSecret, getVaultSecret, resolveVaultRefs } from './keys'

describe('vault secrets + ref resolution', () => {
  beforeEach(() => {
    fakeVaultFiles.clear()
  })

  it('round-trips a namespaced secret', () => {
    setVaultSecret('smithery:apiKey', 'sk-123')
    expect(getVaultSecret('smithery:apiKey')).toBe('sk-123')
  })

  it('empty value deletes', () => {
    setVaultSecret('mcp:foo:token', 'x')
    setVaultSecret('mcp:foo:token', '')
    expect(getVaultSecret('mcp:foo:token')).toBeUndefined()
  })

  it('resolves ${VAULT:key} references, missing → empty', () => {
    setVaultSecret('mcp:gh:token', 'ghp_1')
    expect(resolveVaultRefs('Bearer ${VAULT:mcp:gh:token}')).toBe('Bearer ghp_1')
    expect(resolveVaultRefs('X ${VAULT:nope}')).toBe('X ')
  })
})
