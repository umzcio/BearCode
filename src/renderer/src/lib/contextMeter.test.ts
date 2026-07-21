import { describe, it, expect } from 'vitest'
import {
  estimateTokens,
  conversationTokens,
  contextUsage,
  contextWindowFor,
  latestResolvedModelRef,
  latestUsage,
  usageByModel,
  conversationCost,
  costByRole
} from './contextMeter'
import type { Event, ProviderModels } from '@shared/types'

function turnMeta(
  id: string,
  provider: string,
  model: string,
  usage?: {
    inputTokens: number
    outputTokens: number
    lastInputTokens: number
    costUsd?: number
  },
  ursaClassifierUsage?: {
    modelRef: string
    inputTokens: number
    outputTokens: number
    costUsd?: number
  },
  ursaRole?: string,
  ursaCouncilUsage?: Array<{
    modelRef: string
    inputTokens: number
    outputTokens: number
    costUsd?: number
  }>
): Event {
  return {
    type: 'turn_meta',
    id,
    provider,
    model,
    startedAt: 0,
    endedAt: 1,
    usage,
    ...(ursaClassifierUsage ? { ursaClassifierUsage } : {}),
    ...(ursaRole ? { ursaRole } : {}),
    ...(ursaCouncilUsage ? { ursaCouncilUsage } : {})
  }
}

describe('contextMeter', () => {
  it('estimateTokens ~ chars/4', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2) // ceil(5/4)
  })
  it('conversationTokens sums text over user/assistant/tool_result', () => {
    const events: Event[] = [
      { type: 'user_message', id: 'u', text: 'a'.repeat(8) },
      { type: 'assistant_text', id: 'a', text: 'b'.repeat(4) },
      {
        type: 'tool_result',
        id: 't',
        callId: 'c',
        output: 'c'.repeat(4),
        durationMs: 0,
        truncated: false
      },
      { type: 'error', id: 'e', message: 'ignored', recoverable: true }
    ]
    expect(conversationTokens(events)).toBe(2 + 1 + 1) // 8/4 + 4/4 + 4/4
  })
  it('contextUsage computes pct + near (>=80%)', () => {
    expect(contextUsage(50, 100)).toEqual({ pct: 50, near: false })
    expect(contextUsage(80, 100)).toEqual({ pct: 80, near: true })
    expect(contextUsage(120, 100)).toEqual({ pct: 120, near: true })
  })
  it('contextWindowFor resolves via providers + modelRef', () => {
    const providers: ProviderModels[] = [
      {
        id: 'anthropic',
        displayName: 'A',
        color: '#000',
        requiresKey: true,
        keyConfigured: true,
        reachable: true,
        models: [{ id: 'claude-opus-4-8', label: 'Opus', contextWindow: 1_000_000 }]
      }
    ] as unknown as ProviderModels[]
    expect(contextWindowFor(providers, 'anthropic/claude-opus-4-8')).toBe(1_000_000)
    expect(contextWindowFor(providers, 'anthropic/unknown')).toBeUndefined()
    expect(contextWindowFor(providers, null)).toBeUndefined()
  })

  it('latestResolvedModelRef returns the newest turn_meta\'s concrete provider/model, null when none', () => {
    expect(latestResolvedModelRef([{ type: 'user_message', id: 'u', text: 'hi' }])).toBeNull()
    const events: Event[] = [
      turnMeta('t1', 'openrouter', 'moonshotai/kimi-k3'),
      { type: 'user_message', id: 'u', text: 'hi' },
      turnMeta('t2', 'ollama', 'ornith:35b')
    ]
    expect(latestResolvedModelRef(events)).toBe('ollama/ornith:35b')
  })

  it('latestUsage returns the newest turn_meta usage, null when none', () => {
    expect(latestUsage([{ type: 'user_message', id: 'u', text: 'hi' }])).toBeNull()
    expect(latestUsage([turnMeta('t1', 'anthropic', 'claude-opus-4-8')])).toBeNull()
    const events: Event[] = [
      turnMeta('t1', 'anthropic', 'claude-opus-4-8', {
        inputTokens: 10,
        outputTokens: 5,
        lastInputTokens: 8
      }),
      { type: 'user_message', id: 'u', text: 'hi' },
      turnMeta('t2', 'anthropic', 'claude-opus-4-8', {
        inputTokens: 30,
        outputTokens: 7,
        lastInputTokens: 25
      })
    ]
    expect(latestUsage(events)).toEqual({ inputTokens: 30, outputTokens: 7, lastInputTokens: 25 })
  })

  it('usageByModel sums input/output grouped by provider/model across a switch', () => {
    const events: Event[] = [
      turnMeta('t1', 'anthropic', 'claude-opus-4-8', {
        inputTokens: 10,
        outputTokens: 5,
        lastInputTokens: 10
      }),
      turnMeta('t2', 'openai', 'gpt-5', {
        inputTokens: 100,
        outputTokens: 50,
        lastInputTokens: 100
      }),
      turnMeta('t3', 'anthropic', 'claude-opus-4-8', {
        inputTokens: 20,
        outputTokens: 3,
        lastInputTokens: 20
      }),
      // turn_meta without usage is skipped
      turnMeta('t4', 'openai', 'gpt-5')
    ]
    const rows = usageByModel(events)
    expect(rows).toEqual([
      {
        modelRef: 'anthropic/claude-opus-4-8',
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        inputTokens: 30,
        outputTokens: 8
      },
      {
        modelRef: 'openai/gpt-5',
        provider: 'openai',
        model: 'gpt-5',
        inputTokens: 100,
        outputTokens: 50
      }
    ])
  })

  it('usageByModel folds the Ursa classifier usage in under the classifier model', () => {
    const events: Event[] = [
      // An Ursa-routed turn: the role ran on openai/gpt-5.6-sol, but the
      // classifier ran on anthropic/claude-haiku-4-5 and reported its own cost.
      turnMeta(
        't1',
        'openai',
        'gpt-5.6-sol',
        { inputTokens: 200, outputTokens: 40, lastInputTokens: 200 },
        { modelRef: 'anthropic/claude-haiku-4-5', inputTokens: 120, outputTokens: 6 }
      ),
      // A second turn whose classifier hit the same cheap model -- accumulates.
      turnMeta(
        't2',
        'anthropic',
        'claude-sonnet-5',
        { inputTokens: 50, outputTokens: 10, lastInputTokens: 50 },
        { modelRef: 'anthropic/claude-haiku-4-5', inputTokens: 30, outputTokens: 2 }
      )
    ]
    const rows = usageByModel(events)
    expect(rows).toEqual([
      {
        modelRef: 'openai/gpt-5.6-sol',
        provider: 'openai',
        model: 'gpt-5.6-sol',
        inputTokens: 200,
        outputTokens: 40
      },
      {
        modelRef: 'anthropic/claude-haiku-4-5',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        inputTokens: 150,
        outputTokens: 8
      },
      {
        modelRef: 'anthropic/claude-sonnet-5',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        inputTokens: 50,
        outputTokens: 10
      }
    ])
  })

  it('usageByModel folds each council seat/review call in under its own seat model', () => {
    const events: Event[] = [
      turnMeta(
        't1',
        'anthropic',
        'claude-fable-5', // the chair's own usage rides the normal slot
        { inputTokens: 300, outputTokens: 80, lastInputTokens: 300 },
        undefined,
        'council',
        [
          { modelRef: 'openai/gpt-5.6-sol', inputTokens: 10, outputTokens: 5 },
          { modelRef: 'openai/gpt-5.6-sol', inputTokens: 12, outputTokens: 6 }, // its review
          { modelRef: 'xai/grok-4.5', inputTokens: 20, outputTokens: 8 }
        ]
      )
    ]
    const rows = usageByModel(events)
    expect(rows).toEqual([
      {
        modelRef: 'anthropic/claude-fable-5',
        provider: 'anthropic',
        model: 'claude-fable-5',
        inputTokens: 300,
        outputTokens: 80
      },
      {
        modelRef: 'openai/gpt-5.6-sol',
        provider: 'openai',
        model: 'gpt-5.6-sol',
        inputTokens: 22,
        outputTokens: 11
      },
      {
        modelRef: 'xai/grok-4.5',
        provider: 'xai',
        model: 'grok-4.5',
        inputTokens: 20,
        outputTokens: 8
      }
    ])
  })

  it('costByRole books every council seat call under the council role', () => {
    const events: Event[] = [
      // council: fable chair (in 1M @ its price) + one seat call (in 1M) all
      // attributed to the 'council' role. Assert accumulation + that seats fold in.
      turnMeta(
        't1',
        'anthropic',
        'claude-sonnet-5',
        { inputTokens: 1_000_000, outputTokens: 0, lastInputTokens: 1_000_000 },
        undefined,
        'council',
        [{ modelRef: 'anthropic/claude-sonnet-5', inputTokens: 1_000_000, outputTokens: 0 }]
      )
    ]
    const rows = costByRole(events)
    expect(rows).toHaveLength(1)
    expect(rows[0].role).toBe('council')
    // sonnet in @ $3/1M twice = 6
    expect(rows[0].cost).toBeCloseTo(6, 6)
    expect(rows[0].hasUnknown).toBe(false)
  })

  it('costByRole is empty when no turn carries an ursaRole', () => {
    const events: Event[] = [
      turnMeta('t1', 'anthropic', 'claude-opus-4-8', {
        inputTokens: 1_000_000,
        outputTokens: 0,
        lastInputTokens: 1_000_000
      })
    ]
    expect(costByRole(events)).toEqual([])
  })

  it('costByRole sums per role, folding in the turn model + its classifier cost', () => {
    const events: Event[] = [
      // coder: opus main (in 1M @ $5 = 5) + haiku classifier (in 1M @ $1 = 1) = 6
      turnMeta(
        't1',
        'anthropic',
        'claude-opus-4-8',
        { inputTokens: 1_000_000, outputTokens: 0, lastInputTokens: 1_000_000 },
        { modelRef: 'anthropic/claude-haiku-4-5', inputTokens: 1_000_000, outputTokens: 0 },
        'coder'
      ),
      // writer: sonnet main (in 1M @ $3 = 3), no classifier reported = 3
      turnMeta(
        't2',
        'anthropic',
        'claude-sonnet-5',
        { inputTokens: 1_000_000, outputTokens: 0, lastInputTokens: 1_000_000 },
        undefined,
        'writer'
      ),
      // a second coder turn accumulates: sonnet main (in 1M @ $3 = 3) => coder now 9
      turnMeta(
        't3',
        'anthropic',
        'claude-sonnet-5',
        { inputTokens: 1_000_000, outputTokens: 0, lastInputTokens: 1_000_000 },
        undefined,
        'coder'
      )
    ]
    const rows = costByRole(events)
    expect(rows.map((r) => r.role)).toEqual(['coder', 'writer']) // first-seen order
    expect(rows[0].cost).toBeCloseTo(9, 6)
    expect(rows[0].hasUnknown).toBe(false)
    expect(rows[1].cost).toBeCloseTo(3, 6)
  })

  it('costByRole flags an unpriced model without crediting cost', () => {
    const events: Event[] = [
      turnMeta(
        't1',
        'ollama',
        'llama3',
        { inputTokens: 1_000_000, outputTokens: 1_000_000, lastInputTokens: 1_000_000 },
        undefined,
        'local'
      )
    ]
    const rows = costByRole(events)
    expect(rows).toEqual([{ role: 'local', cost: 0, hasUnknown: true }])
  })

  // OpenRouter reports the real charge per call (usage accounting). BearCode's
  // synced LiteLLM price map covers almost none of its catalog, so without this
  // precedence every Ursus turn read "unpriced" and cost $0.00.
  describe('provider-reported cost beats the derived price table', () => {
    it('usageByModel sums a reported cost per model, and leaves it undefined when none', () => {
      const events: Event[] = [
        turnMeta('t1', 'openrouter', 'z-ai/glm-5.2', {
          inputTokens: 100,
          outputTokens: 50,
          lastInputTokens: 100,
          costUsd: 0.004
        }),
        turnMeta('t2', 'openrouter', 'z-ai/glm-5.2', {
          inputTokens: 200,
          outputTokens: 60,
          lastInputTokens: 200,
          costUsd: 0.006
        }),
        turnMeta('t3', 'anthropic', 'claude-opus-4-8', {
          inputTokens: 10,
          outputTokens: 10,
          lastInputTokens: 10
        })
      ]
      const rows = usageByModel(events)
      const glm = rows.find((r) => r.modelRef === 'openrouter/z-ai/glm-5.2')
      expect(glm?.reportedCostUsd).toBeCloseTo(0.01, 10)
      expect(rows.find((r) => r.modelRef === 'anthropic/claude-opus-4-8')?.reportedCostUsd).toBeUndefined()
    })

    it('conversationCost uses the reported figure and does NOT flag it unpriced', () => {
      const byModel = [
        {
          modelRef: 'openrouter/moonshotai/kimi-k3',
          provider: 'openrouter',
          model: 'moonshotai/kimi-k3',
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          reportedCostUsd: 0.42
        }
      ]
      const cost = conversationCost(byModel)
      expect(cost.total).toBeCloseTo(0.42, 10)
      // The whole point: this model has no price-table entry, but it is priced.
      expect(cost.hasUnknown).toBe(false)
    })

    it('a reported zero counts as free, not as unpriced', () => {
      const cost = conversationCost([
        {
          modelRef: 'openrouter/some/free-model',
          provider: 'openrouter',
          model: 'some/free-model',
          inputTokens: 500,
          outputTokens: 500,
          reportedCostUsd: 0
        }
      ])
      expect(cost.total).toBe(0)
      expect(cost.hasUnknown).toBe(false)
    })

    it('costByRole credits a reported council cost instead of flagging unknown', () => {
      const events: Event[] = [
        {
          type: 'turn_meta',
          id: 't1',
          provider: 'openrouter',
          model: 'deepseek/deepseek-v4-pro',
          startedAt: 0,
          endedAt: 1,
          ursaRole: 'council',
          usage: { inputTokens: 10, outputTokens: 10, lastInputTokens: 10, costUsd: 0.02 },
          ursaCouncilUsage: [
            {
              modelRef: 'openrouter/moonshotai/kimi-k3',
              inputTokens: 5,
              outputTokens: 5,
              costUsd: 0.01
            }
          ]
        } as unknown as Event
      ]
      expect(costByRole(events)).toEqual([
        { role: 'council', cost: expect.closeTo(0.03, 10), hasUnknown: false }
      ])
    })
  })

  it('conversationCost multiplies tokens x per-1M price, sums total, flags unknown', () => {
    const byModel = [
      {
        modelRef: 'anthropic/claude-opus-4-8',
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000
      },
      {
        modelRef: 'ollama/llama3',
        provider: 'ollama',
        model: 'llama3',
        inputTokens: 500_000,
        outputTokens: 500_000
      }
    ]
    // Bundled anthropic/claude-opus-4-8 = { inputPer1M: 5, outputPer1M: 25 } => 5 + 25 = 30
    const cost = conversationCost(byModel)
    expect(cost.perModel['anthropic/claude-opus-4-8']).toBeCloseTo(30, 6)
    expect(cost.perModel['ollama/llama3']).toBeUndefined()
    expect(cost.total).toBeCloseTo(30, 6)
    expect(cost.hasUnknown).toBe(true)
  })
})
