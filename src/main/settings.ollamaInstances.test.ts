import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/nonexistent') } }))
// Keep reads failing (falls back to DEFAULTS) and make writes a no-op so the
// setSettings return value can be asserted without touching a real disk. The
// downgrade-read test overrides readFileSync per-call.
vi.mock('fs', () => ({
  readFileSync: vi.fn(() => {
    throw new Error('no file')
  }),
  writeFileSync: vi.fn()
}))

import { readFileSync } from 'fs'
import { migrateSettings, setSettings, coerceOllamaInstances } from './settings'

const LOCAL = { id: 'local', name: 'Local', baseUrl: 'http://localhost:11434' }

describe('migrateSettings ollamaInstances migration', () => {
  it('defaults to the local instance when nothing is persisted', () => {
    const s = migrateSettings({})
    expect(s.ollamaInstances).toEqual([LOCAL])
    expect(s.ollamaBaseUrl).toBe('http://localhost:11434')
  })
  it('seeds the local instance from a legacy ollamaBaseUrl (downgrade read)', () => {
    const s = migrateSettings({ ollamaBaseUrl: 'http://nas.local:11434' })
    expect(s.ollamaInstances).toEqual([
      { id: 'local', name: 'Local', baseUrl: 'http://nas.local:11434' }
    ])
    expect(s.ollamaBaseUrl).toBe('http://nas.local:11434')
  })
  it('is idempotent: a seeded list round-trips unchanged through a second load', () => {
    const once = migrateSettings({ ollamaBaseUrl: 'http://nas.local:11434' })
    const twice = migrateSettings({ ...once } as Record<string, unknown>)
    expect(twice.ollamaInstances).toEqual(once.ollamaInstances)
    expect(twice.ollamaBaseUrl).toBe(once.ollamaBaseUrl)
  })
  it('falls back to the localhost default when the legacy URL is invalid', () => {
    for (const bad of ['not-a-url', 'ftp://x:11434', 7, null]) {
      const s = migrateSettings({ ollamaBaseUrl: bad })
      expect(s.ollamaInstances).toEqual([LOCAL])
      expect(s.ollamaBaseUrl).toBe('http://localhost:11434')
    }
  })
  it('keeps a valid persisted list and mirrors ollamaBaseUrl to the primary', () => {
    const instances = [
      { id: 'local', name: 'Local', baseUrl: 'http://localhost:11434' },
      { id: 'gpu-box', name: 'GPU Box', baseUrl: 'https://gpu.example.com:11434' }
    ]
    const s = migrateSettings({ ollamaInstances: instances, ollamaBaseUrl: 'http://stale:1' })
    expect(s.ollamaInstances).toEqual(instances)
    expect(s.ollamaBaseUrl).toBe('http://localhost:11434')
  })
  it('a valid list with a reordered primary mirrors that primary, not local', () => {
    const instances = [
      { id: 'gpu-box', name: 'GPU Box', baseUrl: 'https://gpu.example.com:11434' },
      { id: 'local', name: 'Local', baseUrl: 'http://localhost:11434' }
    ]
    const s = migrateSettings({ ollamaInstances: instances })
    expect(s.ollamaInstances).toEqual(instances)
    expect(s.ollamaBaseUrl).toBe('https://gpu.example.com:11434')
  })
  it('seeds from legacy ollamaBaseUrl when every persisted instance is invalid', () => {
    const s = migrateSettings({
      ollamaBaseUrl: 'http://nas.local:11434',
      ollamaInstances: [{ id: 'bad id!', name: 'X', baseUrl: 'http://x:1' }, 'garbage', 42]
    })
    expect(s.ollamaInstances).toEqual([
      { id: 'local', name: 'Local', baseUrl: 'http://nas.local:11434' }
    ])
    expect(s.ollamaBaseUrl).toBe('http://nas.local:11434')
  })
})

describe('coerceOllamaInstances', () => {
  it('returns [] for non-arrays', () => {
    expect(coerceOllamaInstances(undefined)).toEqual([])
    expect(coerceOllamaInstances('local')).toEqual([])
    expect(coerceOllamaInstances({ id: 'local' })).toEqual([])
  })
  it('keeps well-formed entries', () => {
    expect(coerceOllamaInstances([LOCAL])).toEqual([LOCAL])
  })
  it('drops entries with unparseable or non-http(s) baseUrls', () => {
    const out = coerceOllamaInstances([
      { id: 'a', name: 'A', baseUrl: 'not-a-url' },
      { id: 'b', name: 'B', baseUrl: 'ftp://x:11434' },
      { id: 'c', name: 'C', baseUrl: '' },
      { id: 'd', name: 'D', baseUrl: 11434 },
      LOCAL
    ])
    expect(out).toEqual([LOCAL])
  })
  it('drops duplicate ids (first occurrence wins)', () => {
    const out = coerceOllamaInstances([
      { id: 'local', name: 'First', baseUrl: 'http://localhost:11434' },
      { id: 'local', name: 'Second', baseUrl: 'http://other:11434' }
    ])
    expect(out).toEqual([{ id: 'local', name: 'First', baseUrl: 'http://localhost:11434' }])
  })
  it('drops entries with missing or blank names', () => {
    const out = coerceOllamaInstances([
      { id: 'a', name: '', baseUrl: 'http://a:11434' },
      { id: 'b', name: '   ', baseUrl: 'http://b:11434' },
      { id: 'c', baseUrl: 'http://c:11434' },
      LOCAL
    ])
    expect(out).toEqual([LOCAL])
  })
  it('drops entries with non-kebab-case ids', () => {
    const out = coerceOllamaInstances([
      { id: 'Bad Id', name: 'A', baseUrl: 'http://a:11434' },
      { id: '-leading-dash', name: 'B', baseUrl: 'http://b:11434' },
      { id: '', name: 'C', baseUrl: 'http://c:11434' },
      { id: 'gpu-box-2', name: 'D', baseUrl: 'http://d:11434' }
    ])
    expect(out).toEqual([{ id: 'gpu-box-2', name: 'D', baseUrl: 'http://d:11434' }])
  })
  it('caps oversized display names', () => {
    const out = coerceOllamaInstances([
      { id: 'a', name: 'x'.repeat(100), baseUrl: 'http://a:11434' }
    ])
    expect(out[0].name).toHaveLength(40)
  })
})

describe('setSettings ollamaInstances mirror', () => {
  it('writing instances mirrors ollamaBaseUrl to the primary baseUrl', () => {
    const next = setSettings({
      ollamaInstances: [
        { id: 'local', name: 'Local', baseUrl: 'http://localhost:11434' },
        { id: 'gpu-box', name: 'GPU Box', baseUrl: 'https://gpu.example.com:11434' }
      ]
    })
    expect(next.ollamaBaseUrl).toBe('http://localhost:11434')
    expect(next.ollamaInstances).toHaveLength(2)
  })
  it('writing instances wins over a direct ollamaBaseUrl in the same patch', () => {
    const next = setSettings({
      ollamaBaseUrl: 'http://ignored:1',
      ollamaInstances: [{ id: 'gpu-box', name: 'GPU Box', baseUrl: 'https://gpu.example.com' }]
    })
    expect(next.ollamaBaseUrl).toBe('https://gpu.example.com')
  })
  it('writing ollamaBaseUrl directly updates the primary instance, keeping id/name and siblings', () => {
    setSettings({
      ollamaInstances: [
        { id: 'gpu-box', name: 'GPU Box', baseUrl: 'https://gpu.example.com' },
        { id: 'local', name: 'Local', baseUrl: 'http://localhost:11434' }
      ]
    })
    const next = setSettings({ ollamaBaseUrl: 'http://new-primary:11434' })
    expect(next.ollamaInstances).toEqual([
      { id: 'gpu-box', name: 'GPU Box', baseUrl: 'http://new-primary:11434' },
      { id: 'local', name: 'Local', baseUrl: 'http://localhost:11434' }
    ])
    expect(next.ollamaBaseUrl).toBe('http://new-primary:11434')
  })
  it('coerces a malformed instance write (bad entries dropped, never persisted)', () => {
    const next = setSettings({
      ollamaInstances: [
        { id: 'local', name: 'Local', baseUrl: 'http://localhost:11434' },
        { id: 'bad', name: 'Bad', baseUrl: 'nope' },
        { id: 'local', name: 'Dupe', baseUrl: 'http://dupe:11434' }
      ]
    })
    expect(next.ollamaInstances).toEqual([LOCAL])
    expect(next.ollamaBaseUrl).toBe('http://localhost:11434')
  })
  it('an all-invalid instance write falls back to the default local instance', () => {
    const next = setSettings({
      ollamaInstances: [{ id: 'bad', name: 'Bad', baseUrl: 'nope' }]
    })
    expect(next.ollamaInstances).toEqual([LOCAL])
    expect(next.ollamaBaseUrl).toBe('http://localhost:11434')
  })
  it('an invalid direct ollamaBaseUrl write falls back to the localhost default', () => {
    const next = setSettings({ ollamaBaseUrl: 'not-a-url' })
    expect(next.ollamaBaseUrl).toBe('http://localhost:11434')
    expect(next.ollamaInstances?.[0].baseUrl).toBe('http://localhost:11434')
  })
})

describe('getSettings downgrade read', () => {
  it('reads a settings file containing only the legacy ollamaBaseUrl', async () => {
    vi.mocked(readFileSync).mockImplementationOnce(
      () => JSON.stringify({ ollamaBaseUrl: 'http://nas.local:11434' }) as never
    )
    vi.resetModules()
    const fresh = await import('./settings')
    const s = fresh.getSettings()
    expect(s.ollamaBaseUrl).toBe('http://nas.local:11434')
    expect(s.ollamaInstances).toEqual([
      { id: 'local', name: 'Local', baseUrl: 'http://nas.local:11434' }
    ])
  })
})
