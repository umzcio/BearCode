import { describe, it, expect, vi } from 'vitest'

vi.mock('../keys', () => ({
  getKey: (p: string) =>
    ['anthropic', 'perplexity', 'xai', 'openai', 'openrouter'].includes(p) ? 'sk-test' : undefined
}))

import { makeModel, buildModelExtras, attachOpenRouterCost } from './models'

describe('makeModel', () => {
  it('builds an Anthropic model when the key exists', () => {
    const m = makeModel('anthropic/claude-haiku-4-5')
    expect(m).toBeTruthy()
    expect(m._llmType()).toContain('anthropic')
  })
  it('throws a clear error when the key is missing', () => {
    expect(() => makeModel('google/gemini-2.5-pro')).toThrow(/google/i)
  })

  it('builds Perplexity as an OpenAI-compatible client pointed at the Perplexity baseURL', () => {
    const m = makeModel('perplexity/sonar-pro')
    expect(m._llmType()).toContain('openai')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((m as any).clientConfig.baseURL).toBe('https://api.perplexity.ai')
  })

  it('Perplexity models copy top-level citations/search_results onto response_metadata', () => {
    const m = makeModel('perplexity/sonar')
    const raw = {
      id: 'x',
      choices: [],
      citations: ['https://a.com'],
      search_results: [{ title: 'A', url: 'https://a.com' }]
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chunk = (m as any)._convertCompletionsDeltaToBaseMessageChunk(
      { role: 'assistant', content: 'hi' },
      raw
    )
    const msg = chunk?.message ?? chunk
    expect(msg.response_metadata.citations).toEqual(['https://a.com'])
    expect(msg.response_metadata.search_results).toEqual([{ title: 'A', url: 'https://a.com' }])
  })

  it('Perplexity models refuse tool binding (endpoint 400s on any `tools` array)', () => {
    const m = makeModel('perplexity/sonar')
    // The agent loop bindTools()s every main model; for Perplexity the bind
    // must be a no-op returning the same instance so no request ever carries
    // tools. A regular provider (anthropic) returns a NEW bound runnable.
    const fakeTool = { name: 't', description: 'd', schema: { type: 'object' } }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((m as any).bindTools([fakeTool])).toBe(m)
    const anthropic = makeModel('anthropic/claude-haiku-4-5')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((anthropic as any).bindTools([fakeTool])).not.toBe(anthropic)
  })

  it('builds xAI as an OpenAI-compatible client pointed at the xAI baseURL', () => {
    const m = makeModel('xai/grok-4.5')
    expect(m._llmType()).toContain('openai')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((m as any).clientConfig.baseURL).toBe('https://api.x.ai/v1')
  })

  it('xAI keeps real tool binding (Grok has native function calling, unlike Perplexity)', () => {
    const m = makeModel('xai/grok-4-fast')
    const fakeTool = { name: 't', description: 'd', schema: { type: 'object' } }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((m as any).bindTools([fakeTool])).not.toBe(m)
  })

  it('xAI search-off is plain completions with NO server tools (410/422-verified)', () => {
    const off = makeModel('xai/grok-4.5')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((off as any).useResponsesApi).toBeFalsy()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const offTypes = ((off as any).invocationParams({}).tools ?? []).map((t: any) => t.type)
    expect(offTypes).toEqual([])
  })

  it('xAI search-on IS a ChatOpenAIResponses instance (no delegate) with the xAI built-ins', () => {
    const on = makeModel('xai/grok-4.5', { webSearch: true })
    // ChatOpenAI delegates generation to an inner Responses object whose
    // invocationParams a ChatOpenAI-subclass override never intercepts (the
    // first live smoke proved it: no server search fired). The search model
    // must BE the Responses class so this override is on the request path.
    expect(on.constructor.name).toBe('OpenAISearchChat')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((on as any).responses).toBeUndefined()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const types = ((on as any).invocationParams({}).tools ?? []).map((t: any) => t.type)
    expect(types).toContain('web_search')
    expect(types).toContain('x_search')
    expect(types).not.toContain('live_search')
  })

  it('OpenAI search-on is also the direct Responses class with web_search', () => {
    const m = makeModel('openai/gpt-5.6-sol', { webSearch: true })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((m as any).responses).toBeUndefined()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const types = ((m as any).invocationParams({}).tools ?? []).map((t: any) => t.type)
    expect(types).toContain('web_search')
  })

  it('Anthropic appends its server web_search tool only when the toggle is on', () => {
    const off = makeModel('anthropic/claude-sonnet-5')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const offTools = (off as any).invocationParams({}).tools ?? []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(offTools.some((t: any) => t?.name === 'web_search')).toBe(false)
    const on = makeModel('anthropic/claude-sonnet-5', { webSearch: true })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onTools = (on as any).invocationParams({}).tools ?? []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ws = onTools.find((t: any) => t?.name === 'web_search')
    expect(ws?.type).toBe('web_search_20250305')
  })

  it('OpenRouter search-off attaches NO server tools (but is still the OR client)', () => {
    const off = makeModel('openrouter/moonshotai/kimi-k3')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const offTypes = ((off as any).invocationParams({}).tools ?? []).map((t: any) => t.type)
    expect(offTypes).not.toContain('openrouter:web_search')
  })

  // Usage accounting is what makes cost work for OpenRouter at all: the synced
  // LiteLLM price map covers almost none of its catalog, so a derived price
  // reads "unpriced" for nearly every model. It must ride EVERY call, not just
  // search-enabled ones.
  it('OpenRouter requests usage accounting whether or not search is on', () => {
    for (const m of [
      makeModel('openrouter/moonshotai/kimi-k3'),
      makeModel('openrouter/moonshotai/kimi-k3', { webSearch: true })
    ]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((m as any).invocationParams({}).usage).toEqual({ include: true })
    }
  })

  describe('attachOpenRouterCost', () => {
    it('lands a reported cost on response_metadata', () => {
      const msg: Record<string, unknown> = {}
      attachOpenRouterCost(msg, { usage: { cost: 0.00123 } })
      expect(msg.response_metadata).toMatchObject({ bearcodeCostUsd: 0.00123 })
    })

    it('keeps a genuine zero (a free model is not the same as unreported)', () => {
      const msg: Record<string, unknown> = {}
      attachOpenRouterCost(msg, { usage: { cost: 0 } })
      expect(msg.response_metadata).toMatchObject({ bearcodeCostUsd: 0 })
    })

    it('ignores a missing/non-numeric cost and non-final stream chunks', () => {
      for (const raw of [{}, { usage: {} }, { usage: { cost: 'free' } }, undefined]) {
        const msg: Record<string, unknown> = {}
        attachOpenRouterCost(msg, raw)
        expect(msg.response_metadata).toBeUndefined()
      }
    })

    it('preserves any metadata already attached (e.g. search citations)', () => {
      const msg: Record<string, unknown> = { response_metadata: { search_results: [{ url: 'u' }] } }
      attachOpenRouterCost(msg, { usage: { cost: 2 } })
      expect(msg.response_metadata).toEqual({
        search_results: [{ url: 'u' }],
        bearcodeCostUsd: 2
      })
    })
  })

  it('OpenRouter search-on IS an OpenRouterSearchChat instance with the openrouter:web_search tool', () => {
    const on = makeModel('openrouter/moonshotai/kimi-k3', { webSearch: true })
    expect(on.constructor.name).toBe('OpenRouterSearchChat')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const types = ((on as any).invocationParams({}).tools ?? []).map((t: any) => t.type)
    expect(types).toContain('openrouter:web_search')
  })

  it('OpenRouter search-on does not duplicate the server tool across repeated invocationParams calls', () => {
    const on = makeModel('openrouter/moonshotai/kimi-k3', { webSearch: true })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = on as any
    m.invocationParams({})
    const params = m.invocationParams({})
    const types = (params.tools ?? []).map((t: { type?: string }) => t.type)
    expect(types.filter((t: string) => t === 'openrouter:web_search')).toHaveLength(1)
  })

  it('grok-4.20-multi-agent carries agent_count in its request params', () => {
    const m = makeModel('xai/grok-4.20-multi-agent', { effort: 'high' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params = (m as any).invocationParams({})
    expect(params.agent_count).toBe(16)
  })

  it('xAI search-on merges server tools with bound client tools without duplicating', () => {
    const m = makeModel('xai/grok-4.5', { webSearch: true })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params = (m as any).invocationParams({ tools: [{ type: 'web_search' }] })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const types = (params.tools ?? []).map((t: any) => t.type)
    expect(types.filter((t: string) => t === 'web_search')).toHaveLength(1)
    expect(types).toContain('x_search')
  })

  it('xAI copies Live Search citations onto response_metadata like Perplexity', () => {
    const m = makeModel('xai/grok-4.5')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chunk = (m as any)._convertCompletionsDeltaToBaseMessageChunk(
      { role: 'assistant', content: 'hi' },
      { id: 'x', choices: [], citations: ['https://x.com/some-post'] }
    )
    const msg = chunk?.message ?? chunk
    expect(msg.response_metadata.citations).toEqual(['https://x.com/some-post'])
  })

  it('OpenRouter search results normalize url_citation annotations onto response_metadata.search_results', () => {
    const m = makeModel('openrouter/moonshotai/kimi-k3', { webSearch: true })
    const raw = {
      id: 'x',
      choices: [],
      annotations: [
        { type: 'url_citation', url: 'https://a.com', title: 'A', content: 'excerpt', start_index: 0, end_index: 5 },
        { type: 'url_citation', url: 'https://b.com', content: 'excerpt with no title' },
        { type: 'something_else', url: 'https://ignored.com' }
      ]
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chunk = (m as any)._convertCompletionsDeltaToBaseMessageChunk(
      { role: 'assistant', content: 'hi' },
      raw
    )
    const msg = chunk?.message ?? chunk
    expect(msg.response_metadata.search_results).toEqual([
      { url: 'https://a.com', title: 'A' },
      { url: 'https://b.com' }
    ])
  })

  it('OpenRouter with no annotations leaves response_metadata.search_results unset', () => {
    const m = makeModel('openrouter/moonshotai/kimi-k3', { webSearch: true })
    const raw = { id: 'x', choices: [] }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chunk = (m as any)._convertCompletionsDeltaToBaseMessageChunk(
      { role: 'assistant', content: 'hi' },
      raw
    )
    const msg = chunk?.message ?? chunk
    expect(msg.response_metadata?.search_results).toBeUndefined()
  })
})

describe('buildModelExtras — OpenAI reasoning models', () => {
  it('sets reasoning.effort for a GPT-5.6 model using the registry default', () => {
    const extras = buildModelExtras('openai', 'gpt-5.6-luna', {})
    expect(extras.reasoning).toEqual({ effort: 'medium' })
  })

  it('maps the conversation EffortLevel onto reasoning.effort when set', () => {
    const extras = buildModelExtras('openai', 'gpt-5.6-luna', { effort: 'high' })
    expect(extras.reasoning).toEqual({ effort: 'high' })
  })

  it('maps "adaptive" to "medium" and "max" to "xhigh" (OpenAI has no adaptive/max tier)', () => {
    expect(buildModelExtras('openai', 'gpt-5.6-luna', { effort: 'adaptive' }).reasoning).toEqual({
      effort: 'medium'
    })
    expect(buildModelExtras('openai', 'gpt-5.6-luna', { effort: 'max' }).reasoning).toEqual({
      effort: 'xhigh'
    })
  })

  it('sets nothing for a non-reasoning OpenAI model (registry has no entry)', () => {
    const extras = buildModelExtras('openai', 'some-legacy-model', {})
    expect(extras).toEqual({})
  })

  it('forces useResponsesApi so reasoning + function tools can coexist (Chat Completions rejects reasoning_effort with tools)', () => {
    const extras = buildModelExtras('openai', 'gpt-5.6-luna', {})
    expect(extras.useResponsesApi).toBe(true)
  })

  it('never forces useResponsesApi for openrouter, even though it shares the OpenAI-compatible client', () => {
    const extras = buildModelExtras('openrouter', 'deepseek/deepseek-chat', {})
    expect(extras).toEqual({})
  })

  it('never forces useResponsesApi for perplexity (its endpoint does not speak the Responses API)', () => {
    const extras = buildModelExtras('perplexity', 'sonar-pro', {})
    expect(extras).toEqual({})
    expect(extras.useResponsesApi).toBeUndefined()
  })

  it('never forces useResponsesApi for xai (its endpoint does not speak the Responses API)', () => {
    const extras = buildModelExtras('xai', 'grok-4.5', {})
    expect(extras).toEqual({})
    expect(extras.useResponsesApi).toBeUndefined()
  })

  it('grok-4.20-multi-agent maps effort onto agent_count (low/medium=4, high+=16)', () => {
    expect(buildModelExtras('xai', 'grok-4.20-multi-agent', {})).toEqual({
      modelKwargs: { agent_count: 4 } // registry default effort 'medium'
    })
    expect(buildModelExtras('xai', 'grok-4.20-multi-agent', { effort: 'low' })).toEqual({
      modelKwargs: { agent_count: 4 }
    })
    for (const effort of ['high', 'xhigh', 'max'] as const) {
      expect(buildModelExtras('xai', 'grok-4.20-multi-agent', { effort })).toEqual({
        modelKwargs: { agent_count: 16 }
      })
    }
    // No useResponsesApi and no reasoning field -- agent_count IS the knob.
    const extras = buildModelExtras('xai', 'grok-4.20-multi-agent', { effort: 'high' })
    expect(extras.useResponsesApi).toBeUndefined()
    expect(extras.reasoning).toBeUndefined()
  })
})
