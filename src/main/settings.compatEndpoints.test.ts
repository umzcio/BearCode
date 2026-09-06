import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/nonexistent') } }))
// Keep reads failing (falls back to DEFAULTS) and make writes a no-op so the
// setSettings return value can be asserted without touching a real disk.
vi.mock('fs', () => ({
  readFileSync: vi.fn(() => {
    throw new Error('no file')
  }),
  writeFileSync: vi.fn()
}))

import { migrateSettings, setSettings, getSettings, coerceEndpoints } from './settings'

const VLLM = { id: 'vllm', name: 'vLLM box', baseUrl: 'http://gpu.local:8000' }
const LM_STUDIO = { id: 'lm-studio', name: 'LM Studio', baseUrl: 'http://localhost:1234' }

describe('migrateSettings compatEndpoints', () => {
  it('defaults to [] when nothing is persisted (never seeded)', () => {
    const s = migrateSettings({})
    expect(s.compatEndpoints).toEqual([])
  })
  it('keeps a valid persisted list verbatim', () => {
    const s = migrateSettings({ compatEndpoints: [VLLM, LM_STUDIO] })
    expect(s.compatEndpoints).toEqual([VLLM, LM_STUDIO])
  })
  it('an all-invalid persisted list collapses to [] (no seeding, unlike ollamaInstances)', () => {
    const s = migrateSettings({
      compatEndpoints: [{ id: 'bad id!', name: 'X', baseUrl: 'http://x:1' }, 'garbage', 42]
    })
    expect(s.compatEndpoints).toEqual([])
  })
  it('drops malformed entries but keeps the well-formed ones', () => {
    const s = migrateSettings({
      compatEndpoints: [{ id: 'a', name: 'A', baseUrl: 'not-a-url' }, VLLM]
    })
    expect(s.compatEndpoints).toEqual([VLLM])
  })
  it('is idempotent: a coerced list round-trips unchanged through a second load', () => {
    const once = migrateSettings({ compatEndpoints: [VLLM] })
    const twice = migrateSettings({ ...once } as Record<string, unknown>)
    expect(twice.compatEndpoints).toEqual(once.compatEndpoints)
  })
})

describe('coerceEndpoints', () => {
  it('returns [] for non-arrays', () => {
    expect(coerceEndpoints(undefined)).toEqual([])
    expect(coerceEndpoints('vllm')).toEqual([])
    expect(coerceEndpoints({ id: 'vllm' })).toEqual([])
  })
  it('drops entries with unparseable or non-http(s) baseUrls', () => {
    const out = coerceEndpoints([
      { id: 'a', name: 'A', baseUrl: 'not-a-url' },
      { id: 'b', name: 'B', baseUrl: 'ftp://x:8000' },
      { id: 'c', name: 'C', baseUrl: '' },
      { id: 'd', name: 'D', baseUrl: 8000 },
      VLLM
    ])
    expect(out).toEqual([VLLM])
  })
  it('drops duplicate ids (first occurrence wins)', () => {
    const out = coerceEndpoints([
      { id: 'vllm', name: 'First', baseUrl: 'http://gpu.local:8000' },
      { id: 'vllm', name: 'Second', baseUrl: 'http://other:8000' }
    ])
    expect(out).toEqual([{ id: 'vllm', name: 'First', baseUrl: 'http://gpu.local:8000' }])
  })
  it('drops entries with non-kebab-case ids', () => {
    const out = coerceEndpoints([
      { id: 'Bad Id', name: 'A', baseUrl: 'http://a:8000' },
      { id: '-leading-dash', name: 'B', baseUrl: 'http://b:8000' },
      { id: '', name: 'C', baseUrl: 'http://c:8000' },
      LM_STUDIO
    ])
    expect(out).toEqual([LM_STUDIO])
  })
  it('drops entries with missing or blank names', () => {
    const out = coerceEndpoints([
      { id: 'a', name: '', baseUrl: 'http://a:8000' },
      { id: 'b', name: '   ', baseUrl: 'http://b:8000' },
      { id: 'c', baseUrl: 'http://c:8000' },
      VLLM
    ])
    expect(out).toEqual([VLLM])
  })
  it('caps oversized display names at 40 chars', () => {
    const out = coerceEndpoints([{ id: 'a', name: 'x'.repeat(100), baseUrl: 'http://a:8000' }])
    expect(out[0].name).toHaveLength(40)
  })
})

describe('setSettings compatEndpoints write path', () => {
  it('persists a valid list (round-trip through getSettings)', () => {
    const next = setSettings({ compatEndpoints: [VLLM, LM_STUDIO] })
    expect(next.compatEndpoints).toEqual([VLLM, LM_STUDIO])
    expect(getSettings().compatEndpoints).toEqual([VLLM, LM_STUDIO])
  })
  it('coerces a malformed write (bad entries dropped, never persisted)', () => {
    const next = setSettings({
      compatEndpoints: [
        VLLM,
        { id: 'bad', name: 'Bad', baseUrl: 'nope' },
        { id: 'vllm', name: 'Dupe', baseUrl: 'http://dupe:8000' }
      ]
    })
    expect(next.compatEndpoints).toEqual([VLLM])
  })
  it('an all-invalid write stays [] (no default seeding)', () => {
    const next = setSettings({ compatEndpoints: [{ id: 'bad', name: 'Bad', baseUrl: 'nope' }] })
    expect(next.compatEndpoints).toEqual([])
  })
  it('writing endpoints does NOT touch ollamaBaseUrl (no mirror field)', () => {
    const before = getSettings().ollamaBaseUrl
    const next = setSettings({ compatEndpoints: [VLLM] })
    expect(next.ollamaBaseUrl).toBe(before)
  })
  it('clearing the list with [] persists []', () => {
    setSettings({ compatEndpoints: [VLLM] })
    const next = setSettings({ compatEndpoints: [] })
    expect(next.compatEndpoints).toEqual([])
  })
})
