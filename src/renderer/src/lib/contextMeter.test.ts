import { describe, it, expect } from 'vitest'
import {
  estimateTokens,
  conversationTokens,
  contextUsage,
  contextWindowFor,
  latestUsage,
  usageByModel,
  conversationCost
} from './contextMeter'
import type { Event, ProviderModels } from '@shared/types'

function turnMeta(
  id: string,
  provider: string,
  model: string,
  usage?: { inputTokens: number; outputTokens: number; lastInputTokens: number }
): Event {
  return { type: 'turn_meta', id, provider, model, startedAt: 0, endedAt: 1, usage }
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
