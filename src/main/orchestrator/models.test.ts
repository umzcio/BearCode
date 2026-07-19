import { describe, it, expect, vi } from 'vitest'

vi.mock('../keys', () => ({
  getKey: (p: string) =>
    p === 'anthropic' || p === 'perplexity' || p === 'xai' ? 'sk-test' : undefined
}))

import { makeModel, buildModelExtras } from './models'

describe('makeModel', () => {
  it('builds an Anthropic model when the key exists', () => {
    const m = makeModel('anthropic/claude-haiku-4-5')
    expect(m).toBeTruthy()
    expect(m._llmType()).toContain('anthropic')
  })
  it('throws a clear error when the key is missing', () => {
    expect(() => makeModel('openai/gpt-5.1')).toThrow(/openai/i)
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

  it('xAI appends server-side web_search/x_search to every request, even with no bound tools', () => {
    const m = makeModel('xai/grok-4.5')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params = (m as any).invocationParams({})
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const types = (params.tools ?? []).map((t: any) => t.type)
    expect(types).toContain('web_search')
    expect(types).toContain('x_search')
  })

  it('xAI merges server tools with bound client tools without duplicating', () => {
    const m = makeModel('xai/grok-4.5')
    const fakeTool = { type: 'function', function: { name: 't', parameters: { type: 'object' } } }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params = (m as any).invocationParams({ tools: [fakeTool, { type: 'web_search' }] })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const types = (params.tools ?? []).map((t: any) => t.type)
    expect(types.filter((t: string) => t === 'web_search')).toHaveLength(1)
    expect(types).toContain('x_search')
    expect(types).toContain('function')
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
})
