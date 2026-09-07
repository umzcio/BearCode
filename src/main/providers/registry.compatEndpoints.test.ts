// Compat-provider (user-configured OpenAI-compatible endpoints) coverage:
// resolveCompatTarget routing + vault key attachment, listAllCompatEndpoints'
// merged/namespaced catalog, per-endpoint reachability notes, and the
// Authorization: Bearer rules for /v1/models discovery.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./liveDiscovery', () => ({
  fetchAnthropicModels: vi.fn(),
  fetchGoogleModels: vi.fn(),
  fetchOpenAIModels: vi.fn(),
  fetchPerplexityModels: vi.fn(),
  fetchXaiModels: vi.fn()
}))

// Per-endpoint vault keys, keyed by endpointId; tests set entries directly.
const compatKeys: Record<string, string | undefined> = {}
vi.mock('../keys', () => ({
  getKey: () => undefined,
  keyStatus: () => ({}),
  getCompatKey: (endpointId: string) => compatKeys[endpointId]
}))

const ENDPOINTS = [
  { id: 'vllm', name: 'vLLM box', baseUrl: 'http://gpu.local:8000' },
  { id: 'lm-studio', name: 'LM Studio', baseUrl: 'http://localhost:1234' }
]

interface MockCompatSettings {
  compatEndpoints?: typeof ENDPOINTS
}

const getSettingsImpl = vi.fn((): MockCompatSettings => ({ compatEndpoints: ENDPOINTS }))
vi.mock('../settings', () => ({
  getSettings: () => getSettingsImpl()
}))

// A fetch stub keyed by endpoint baseUrl: each entry declares the model ids
// the endpoint's /v1/models serves; a null entry simulates an unreachable
// endpoint. Records each call's headers for the Authorization assertions.
function stubCompatFetch(hosts: Record<string, string[] | null>): ReturnType<typeof vi.fn> {
  const spy = vi.fn((url: string, _init?: { headers?: Record<string, string> }) => {
    for (const [base, ids] of Object.entries(hosts)) {
      if (url === `${base}/v1/models`) {
        if (ids === null) return Promise.reject(new Error('connection refused'))
        return Promise.resolve({
          ok: true,
          json: async () => ({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) })
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
  getSettingsImpl.mockReturnValue({ compatEndpoints: ENDPOINTS })
  for (const k of Object.keys(compatKeys)) delete compatKeys[k]
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('compatApiRoot / listCompatModels URL normalization', () => {
  it('never doubles /v1 whether the baseUrl includes it, lacks it, or trails a slash', async () => {
    const seen: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        seen.push(url)
        return Promise.resolve({
          ok: true,
          json: async () => ({ object: 'list', data: [{ id: 'glm-5.3-flash', object: 'model' }] })
        })
      })
    )
    const { listCompatModels } = await import('./registry')
    const withSuffix = await listCompatModels({ baseUrl: 'http://spark.local:8888/v1' })
    const bare = await listCompatModels({ baseUrl: 'http://spark.local:8888' })
    const trailing = await listCompatModels({ baseUrl: 'http://spark.local:8888/' })
    expect(seen).toEqual([
      'http://spark.local:8888/v1/models',
      'http://spark.local:8888/v1/models',
      'http://spark.local:8888/v1/models'
    ])
    for (const r of [withSuffix, bare, trailing]) {
      expect(r.reachable).toBe(true)
      expect(r.models.map((m) => m.id)).toEqual(['glm-5.3-flash'])
    }
  })
})

describe('resolveCompatTarget', () => {
  it('routes a bare ref to the primary endpoint, with no apiKey when none is vaulted', async () => {
    const { resolveCompatTarget } = await import('./registry')
    expect(resolveCompatTarget('qwen3-32b')).toEqual({
      baseUrl: 'http://gpu.local:8000',
      modelName: 'qwen3-32b'
    })
  })

  it('attaches the primary endpoint vault key when one exists', async () => {
    compatKeys['vllm'] = 'primary-secret'
    const { resolveCompatTarget } = await import('./registry')
    expect(resolveCompatTarget('qwen3-32b')).toEqual({
      baseUrl: 'http://gpu.local:8000',
      modelName: 'qwen3-32b',
      apiKey: 'primary-secret'
    })
  })

  it('routes a namespaced ref to the matching non-primary endpoint, vault key attached', async () => {
    compatKeys['lm-studio'] = 'studio-secret'
    const { resolveCompatTarget } = await import('./registry')
    expect(resolveCompatTarget('lm-studio/qwen3-32b')).toEqual({
      baseUrl: 'http://localhost:1234',
      modelName: 'qwen3-32b',
      apiKey: 'studio-secret'
    })
  })

  it('falls back to the primary with the id intact when the first segment matches no endpoint', async () => {
    const { resolveCompatTarget } = await import('./registry')
    expect(resolveCompatTarget('nope/qwen3-32b')).toEqual({
      baseUrl: 'http://gpu.local:8000',
      modelName: 'nope/qwen3-32b'
    })
  })

  it('keeps slash-containing model ids (meta-llama/Llama-3.1-8B-Instruct) intact on the primary', async () => {
    const { resolveCompatTarget } = await import('./registry')
    expect(resolveCompatTarget('meta-llama/Llama-3.1-8B-Instruct')).toEqual({
      baseUrl: 'http://gpu.local:8000',
      modelName: 'meta-llama/Llama-3.1-8B-Instruct'
    })
  })

  it('endpoint ids win a first-segment collision with a same-named model id', async () => {
    const { resolveCompatTarget } = await import('./registry')
    // 'lm-studio/foo' could be a literal model id on the primary, but the
    // endpoint id takes precedence: deterministic routing, same as ollama.
    expect(resolveCompatTarget('lm-studio/foo')).toEqual({
      baseUrl: 'http://localhost:1234',
      modelName: 'foo'
    })
  })

  it('throws when no endpoints are configured (no primary to fall back to)', async () => {
    getSettingsImpl.mockReturnValue({ compatEndpoints: [] })
    const { resolveCompatTarget } = await import('./registry')
    expect(() => resolveCompatTarget('qwen3-32b')).toThrow('No compat endpoints configured')
  })
})

describe('listAllCompatEndpoints', () => {
  it('merges every endpoint, namespacing non-primary ids and keeping primary ids bare', async () => {
    stubCompatFetch({
      'http://gpu.local:8000': ['qwen3-32b'],
      'http://localhost:1234': ['meta-llama/Llama-3.1-8B-Instruct']
    })
    const { listAllCompatEndpoints } = await import('./registry')
    const { models, reachable, note } = await listAllCompatEndpoints()
    expect(reachable).toBe(true)
    expect(note).toBeUndefined()
    expect(models.map((m) => m.id)).toEqual([
      'qwen3-32b',
      'lm-studio/meta-llama/Llama-3.1-8B-Instruct'
    ])
    expect(models.map((m) => m.label)).toEqual([
      'qwen3-32b',
      'lm-studio/meta-llama/Llama-3.1-8B-Instruct'
    ])
  })

  it('stays reachable and names the unreachable endpoint BY DISPLAY NAME when one is down', async () => {
    stubCompatFetch({
      'http://gpu.local:8000': ['qwen3-32b'],
      'http://localhost:1234': null
    })
    const { listAllCompatEndpoints } = await import('./registry')
    const { models, reachable, note } = await listAllCompatEndpoints()
    expect(reachable).toBe(true)
    expect(models.map((m) => m.id)).toEqual(['qwen3-32b'])
    expect(note).toBe('Unreachable: LM Studio')
  })

  it('probes every endpoint even when the primary is down', async () => {
    stubCompatFetch({
      'http://gpu.local:8000': null,
      'http://localhost:1234': ['hermes-3']
    })
    const { listAllCompatEndpoints } = await import('./registry')
    const { models, reachable, note } = await listAllCompatEndpoints()
    expect(reachable).toBe(true)
    expect(models.map((m) => m.id)).toEqual(['lm-studio/hermes-3'])
    expect(note).toBe('Unreachable: vLLM box')
  })

  it('is unreachable only when EVERY endpoint is down, and names them all', async () => {
    stubCompatFetch({
      'http://gpu.local:8000': null,
      'http://localhost:1234': null
    })
    const { listAllCompatEndpoints } = await import('./registry')
    const { models, reachable, note } = await listAllCompatEndpoints()
    expect(reachable).toBe(false)
    expect(models).toEqual([])
    expect(note).toBe('Unreachable: vLLM box, LM Studio')
  })

  it('returns a zero-config result when no endpoints are configured', async () => {
    getSettingsImpl.mockReturnValue({ compatEndpoints: [] })
    const fetchSpy = stubCompatFetch({})
    const { listAllCompatEndpoints } = await import('./registry')
    const result = await listAllCompatEndpoints()
    expect(result).toEqual({
      models: [],
      reachable: false,
      note: 'No endpoints configured',
      endpoints: []
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('also treats a missing compatEndpoints key (hand-built settings) as zero-config', async () => {
    getSettingsImpl.mockReturnValue({})
    const { listAllCompatEndpoints } = await import('./registry')
    const result = await listAllCompatEndpoints()
    expect(result).toEqual({
      models: [],
      reachable: false,
      note: 'No endpoints configured',
      endpoints: []
    })
  })

  it('reports a per-endpoint breakdown (reachable flags + model counts) across endpoints', async () => {
    stubCompatFetch({
      'http://gpu.local:8000': ['qwen3-32b', 'hermes-3'],
      'http://localhost:1234': null
    })
    const { listAllCompatEndpoints } = await import('./registry')
    const { endpoints } = await listAllCompatEndpoints()
    expect(endpoints).toEqual([
      { id: 'vllm', name: 'vLLM box', reachable: true, modelCount: 2 },
      { id: 'lm-studio', name: 'LM Studio', reachable: false, modelCount: 0 }
    ])
  })

  it("drives the REGISTRY 'compat' entry (requiresKey: false)", async () => {
    stubCompatFetch({
      'http://gpu.local:8000': ['qwen3-32b'],
      'http://localhost:1234': ['hermes-3']
    })
    const { getProvider } = await import('./registry')
    const entry = getProvider('compat')
    expect(entry.requiresKey).toBe(false)
    const { models, reachable } = await entry.listModels()
    expect(reachable).toBe(true)
    expect(models.map((m) => m.id)).toEqual(['qwen3-32b', 'lm-studio/hermes-3'])
  })
})

describe('listCompatModels discovery auth', () => {
  it('sends Authorization: Bearer ONLY for endpoints with a vaulted key', async () => {
    compatKeys['lm-studio'] = 'studio-secret'
    const fetchSpy = stubCompatFetch({
      'http://gpu.local:8000': ['qwen3-32b'],
      'http://localhost:1234': ['hermes-3']
    })
    const { listAllCompatEndpoints } = await import('./registry')
    await listAllCompatEndpoints()

    const headersFor = (base: string): Record<string, string> | undefined =>
      (
        fetchSpy.mock.calls.find(([url]) => url === `${base}/v1/models`)?.[1] as
          { headers?: Record<string, string> } | undefined
      )?.headers
    expect(headersFor('http://gpu.local:8000')).toEqual({})
    expect(headersFor('http://localhost:1234')).toEqual({
      Authorization: 'Bearer studio-secret'
    })
  })

  it('parses the OpenAI { data: [{id}] } shape and drops malformed entries', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: async () => ({
            object: 'list',
            data: [{ id: 'qwen3-32b' }, { nope: true }, { id: 42 }, { id: 'hermes-3' }]
          })
        })
      )
    )
    getSettingsImpl.mockReturnValue({ compatEndpoints: [ENDPOINTS[0]] })
    const { listCompatModels } = await import('./registry')
    const { models, reachable } = await listCompatModels({ baseUrl: 'http://gpu.local:8000/' })
    expect(reachable).toBe(true)
    expect(models).toEqual([
      { id: 'qwen3-32b', label: 'qwen3-32b' },
      { id: 'hermes-3', label: 'hermes-3' }
    ])
  })

  it('degrades to reachable:false with a note on HTTP errors, never throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, status: 401 }))
    )
    const { listCompatModels } = await import('./registry')
    const result = await listCompatModels({ baseUrl: 'http://gpu.local:8000', apiKey: 'bad' })
    expect(result.reachable).toBe(false)
    expect(result.models).toEqual([])
    expect(result.note).toBeTruthy()
  })
})
