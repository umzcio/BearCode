// Multi-Ollama-instance coverage: resolveOllamaTarget routing,
// listAllOllamaInstances' merged/namespaced catalog, per-instance
// reachability notes, and context-window cache keying by base+id.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./liveDiscovery', () => ({
  fetchAnthropicModels: vi.fn(),
  fetchGoogleModels: vi.fn(),
  fetchOpenAIModels: vi.fn(),
  fetchPerplexityModels: vi.fn(),
  fetchXaiModels: vi.fn()
}))

vi.mock('../keys', () => ({
  getKey: () => undefined,
  keyStatus: () => ({})
}))

const INSTANCES = [
  { id: 'local', name: 'Local', baseUrl: 'http://localhost:11434' },
  { id: 'gpu', name: 'GPU Box', baseUrl: 'http://gpu.local:11434' }
]

interface MockOllamaSettings {
  ollamaBaseUrl: string
  ollamaInstances?: typeof INSTANCES
}

const getSettingsImpl = vi.fn((): MockOllamaSettings => ({
  ollamaBaseUrl: 'http://localhost:11434',
  ollamaInstances: INSTANCES
}))
vi.mock('../settings', () => ({
  getSettings: () => getSettingsImpl()
}))

// A fetch stub keyed by instance baseUrl: each entry declares the tags the
// instance serves and (optionally) the context length /api/show reports.
// Missing entry or `tags: null` simulates an unreachable instance.
function stubOllamaFetch(
  hosts: Record<string, { tags: string[] | null; show?: Record<string, number> }>
): ReturnType<typeof vi.fn> {
  const spy = vi.fn((url: string, init?: { body?: string }) => {
    for (const [base, host] of Object.entries(hosts)) {
      if (url === `${base}/api/tags`) {
        const tags = host.tags
        if (tags === null) return Promise.reject(new Error('connection refused'))
        return Promise.resolve({
          ok: true,
          json: async () => ({ models: tags.map((name) => ({ name })) })
        })
      }
      if (url === `${base}/api/show`) {
        const model = JSON.parse(init?.body ?? '{}').model as string
        const win = host.show?.[model]
        if (win === undefined) return Promise.resolve({ ok: false, status: 404 })
        return Promise.resolve({
          ok: true,
          json: async () => ({ model_info: { 'llama.context_length': win } })
        })
      }
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`))
  })
  vi.stubGlobal('fetch', spy)
  return spy
}

beforeEach(() => {
  vi.resetModules()
  getSettingsImpl.mockReset()
  getSettingsImpl.mockReturnValue({
    ollamaBaseUrl: 'http://localhost:11434',
    ollamaInstances: INSTANCES
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('resolveOllamaTarget', () => {
  it('routes a bare legacy ref to the primary instance', async () => {
    const { resolveOllamaTarget } = await import('./registry')
    expect(resolveOllamaTarget('llama3')).toEqual({
      baseUrl: 'http://localhost:11434',
      modelName: 'llama3'
    })
  })

  it('routes a legacy tag ref to the primary instance', async () => {
    const { resolveOllamaTarget } = await import('./registry')
    expect(resolveOllamaTarget('llama3.1:8b')).toEqual({
      baseUrl: 'http://localhost:11434',
      modelName: 'llama3.1:8b'
    })
  })

  it('routes a legacy two-segment ref with an unknown first segment to the primary, intact', async () => {
    const { resolveOllamaTarget } = await import('./registry')
    expect(resolveOllamaTarget('foo/bar:latest')).toEqual({
      baseUrl: 'http://localhost:11434',
      modelName: 'foo/bar:latest'
    })
  })

  it('routes a namespaced ref to the matching non-primary instance', async () => {
    const { resolveOllamaTarget } = await import('./registry')
    expect(resolveOllamaTarget('gpu/qwen3:32b')).toEqual({
      baseUrl: 'http://gpu.local:11434',
      modelName: 'qwen3:32b'
    })
  })

  it('falls back to the primary when the first segment matches no instance id', async () => {
    const { resolveOllamaTarget } = await import('./registry')
    expect(resolveOllamaTarget('nope/llama3')).toEqual({
      baseUrl: 'http://localhost:11434',
      modelName: 'nope/llama3'
    })
  })

  it('seeds the primary from the legacy ollamaBaseUrl when ollamaInstances is absent', async () => {
    getSettingsImpl.mockReturnValue({ ollamaBaseUrl: 'http://nas.local:11434' })
    const { resolveOllamaTarget } = await import('./registry')
    expect(resolveOllamaTarget('gpu/llama3')).toEqual({
      baseUrl: 'http://nas.local:11434',
      modelName: 'gpu/llama3'
    })
  })
})

describe('listAllOllamaInstances', () => {
  it('merges every instance, namespacing non-primary ids and keeping primary ids bare', async () => {
    stubOllamaFetch({
      'http://localhost:11434': { tags: ['llama3'] },
      'http://gpu.local:11434': { tags: ['qwen3:32b'] }
    })
    const { listAllOllamaInstances } = await import('./registry')
    const { models, reachable, note } = await listAllOllamaInstances()
    expect(reachable).toBe(true)
    expect(note).toBeUndefined()
    expect(models.map((m) => m.id)).toEqual(['llama3', 'gpu/qwen3:32b'])
    expect(models.map((m) => m.label)).toEqual(['llama3', 'gpu/qwen3:32b'])
  })

  it('stays reachable and names the unreachable instance when one instance is down', async () => {
    stubOllamaFetch({
      'http://localhost:11434': { tags: ['llama3'] },
      'http://gpu.local:11434': { tags: null }
    })
    const { listAllOllamaInstances } = await import('./registry')
    const { models, reachable, note } = await listAllOllamaInstances()
    expect(reachable).toBe(true)
    expect(models.map((m) => m.id)).toEqual(['llama3'])
    expect(note).toBe('Unreachable: GPU Box')
  })

  it('is unreachable only when EVERY instance is down, and names them all', async () => {
    stubOllamaFetch({
      'http://localhost:11434': { tags: null },
      'http://gpu.local:11434': { tags: null }
    })
    const { listAllOllamaInstances } = await import('./registry')
    const { models, reachable, note } = await listAllOllamaInstances()
    expect(reachable).toBe(false)
    expect(models).toEqual([])
    expect(note).toBe('Unreachable: Local, GPU Box')
  })

  it('probes every instance even when the primary is down', async () => {
    stubOllamaFetch({
      'http://localhost:11434': { tags: null },
      'http://gpu.local:11434': { tags: ['qwen3:32b'] }
    })
    const { listAllOllamaInstances } = await import('./registry')
    const { models, reachable, note } = await listAllOllamaInstances()
    expect(reachable).toBe(true)
    expect(models.map((m) => m.id)).toEqual(['gpu/qwen3:32b'])
    expect(note).toBe('Unreachable: Local')
  })

  it('is byte-identical to the legacy single-instance behavior on the default config', async () => {
    getSettingsImpl.mockReturnValue({
      ollamaBaseUrl: 'http://localhost:11434',
      ollamaInstances: [INSTANCES[0]]
    })
    stubOllamaFetch({ 'http://localhost:11434': { tags: ['llama3'] } })
    const { listAllOllamaInstances } = await import('./registry')
    const up = await listAllOllamaInstances()
    expect(up).toEqual({ models: [{ id: 'llama3', label: 'llama3' }], reachable: true })

    stubOllamaFetch({ 'http://localhost:11434': { tags: null } })
    const down = await listAllOllamaInstances()
    expect(down).toEqual({ models: [], reachable: false, note: 'Ollama not running' })
  })

  it("drives the REGISTRY 'ollama' entry with context windows per instance", async () => {
    stubOllamaFetch({
      'http://localhost:11434': { tags: ['llama3'], show: { llama3: 131_072 } },
      'http://gpu.local:11434': { tags: ['qwen3:32b'], show: { 'qwen3:32b': 262_144 } }
    })
    const { getProvider } = await import('./registry')
    const { models, reachable } = await getProvider('ollama').listModels()
    expect(reachable).toBe(true)
    expect(models).toEqual([
      { id: 'llama3', label: 'llama3', contextWindow: 131_072 },
      { id: 'gpu/qwen3:32b', label: 'gpu/qwen3:32b', contextWindow: 262_144 }
    ])
  })
})

describe('ollamaContextWindows cache keying', () => {
  it('keys by base+id so the same tag on two hosts keeps its own window', async () => {
    const fetchSpy = stubOllamaFetch({
      'http://localhost:11434': { tags: ['llama3'], show: { llama3: 131_072 } },
      'http://gpu.local:11434': { tags: ['llama3'], show: { llama3: 262_144 } }
    })
    const { listAllOllamaInstances } = await import('./registry')
    const { models } = await listAllOllamaInstances({ withContextWindows: true })
    expect(models).toEqual([
      { id: 'llama3', label: 'llama3', contextWindow: 131_072 },
      { id: 'gpu/llama3', label: 'gpu/llama3', contextWindow: 262_144 }
    ])
    const showCalls = (): number =>
      fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/api/show')).length
    expect(showCalls()).toBe(2)

    // A second listing hits the per-base+id cache: no further /api/show calls.
    const again = await listAllOllamaInstances({ withContextWindows: true })
    expect(again.models).toEqual(models)
    expect(showCalls()).toBe(2)
  })
})
