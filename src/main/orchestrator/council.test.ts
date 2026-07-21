import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AIMessageChunk } from '@langchain/core/messages'
import type { ProviderId } from '../../shared/types'

// council.ts touches sqlite (../db) and the encrypted key vault (../keys) and
// constructs real provider clients (./models) at call time; mock all three so
// the runner can be exercised in isolation. registry.ts is pure (ref parsing +
// static tables), so it is left real.
vi.mock('./models', () => ({ makeModel: vi.fn() }))
vi.mock('../db', () => ({
  appendEvent: vi.fn(),
  getRecentUrsaContext: vi.fn(() => ''),
  // runCouncil's fire-and-forget maybeGenerateTitle reaches through to this on
  // every successful chair synthesis; without it the call rejects as an
  // unhandled rejection AFTER the assertions pass. Returning a titled meta
  // makes maybeGenerateTitle no-op immediately (its `meta.title` early return).
  getConversationMeta: vi.fn(() => ({ id: 'c1', title: 'titled' }))
}))
vi.mock('../keys', () => ({ keyStatus: vi.fn() }))

import {
  runCouncil,
  eligibleSeats,
  anonymizeForReview,
  buildReviewPrompt,
  buildChairPrompt,
  seatLabel,
  COUNCIL_SEATS,
  URSA_COUNCIL,
  type CouncilSeatAnswer,
  type CouncilConfig
} from './council'
import { makeModel } from './models'
import { keyStatus } from '../keys'
import type { RunSink } from '../sink'
import type { Event } from '../../shared/types'

const ALL_KEYED: Record<ProviderId, boolean> = {
  anthropic: true,
  openai: true,
  google: true,
  openrouter: true,
  perplexity: true,
  xai: true,
  ollama: true
}
const keyed = (overrides: Partial<Record<ProviderId, boolean>> = {}): Record<ProviderId, boolean> => ({
  ...ALL_KEYED,
  ...overrides
})

const makeSink = (): RunSink => ({ emit: vi.fn(), setState: vi.fn(), metaChanged: vi.fn() })
const emitted = (sink: RunSink): Event[] => vi.mocked(sink.emit).mock.calls.map((c) => c[1])

// A fake seat model: invoke() returns distinct text for the answer vs. review
// stage (detected by the peer-review system prompt), with fixed usage.
function seatModel(label: string, signal?: AbortSignal): { invoke: ReturnType<typeof vi.fn> } {
  return {
    invoke: vi.fn(async (msgs: Array<{ content: unknown }>) => {
      if (signal?.aborted) throw new Error('Aborted')
      const sys = String(msgs[0].content)
      const isReview = sys.includes('peer-review')
      return {
        content: isReview ? `${label} review` : `${label} answer`,
        usage_metadata: { input_tokens: 10, output_tokens: 5 }
      }
    })
  }
}

async function* chairStream(parts: string[]): AsyncGenerator<AIMessageChunk> {
  for (const p of parts) yield new AIMessageChunk({ content: p })
  // Final usage-only chunk, as OpenAI-compatible streams send.
  yield new AIMessageChunk({
    content: '',
    usage_metadata: { input_tokens: 100, output_tokens: 50, total_tokens: 150 }
  })
}

function chairModel(parts = ['Synth ', 'answer']): { stream: ReturnType<typeof vi.fn> } {
  return { stream: vi.fn(async () => chairStream(parts)) }
}

const SOL = 'openai/gpt-5.6-sol'
const GEM = 'google/gemini-3.1-pro-preview'
const GROK = 'xai/grok-4.5'
const CHAIR = 'anthropic/claude-fable-5'

beforeEach(() => vi.clearAllMocks())

describe('council pure helpers', () => {
  it('eligibleSeats filters COUNCIL_SEATS by keyStatus', () => {
    vi.mocked(keyStatus).mockReturnValue(keyed({ xai: false }))
    expect(eligibleSeats()).toEqual([SOL, GEM])
    vi.mocked(keyStatus).mockReturnValue(keyed({ openai: false, google: false, xai: false }))
    expect(eligibleSeats()).toEqual([])
  })

  it('COUNCIL_SEATS is exactly the three curated cross-provider refs', () => {
    expect(COUNCIL_SEATS).toEqual([SOL, GEM, GROK])
  })

  it('anonymizeForReview excludes the reviewer and labels by the given order', () => {
    const answers: CouncilSeatAnswer[] = [
      { seatRef: SOL, text: 'a' },
      { seatRef: GEM, text: 'b' },
      { seatRef: GROK, text: 'c' }
    ]
    // Reviewer = SOL, others = [GEM, GROK]; order [1,0] => A=GROK, B=GEM.
    const labeled = anonymizeForReview(SOL, answers, [1, 0])
    expect(labeled).toEqual([
      { label: 'A', seatRef: GROK, text: 'c' },
      { label: 'B', seatRef: GEM, text: 'b' }
    ])
  })

  it('buildReviewPrompt NEVER leaks a model name/ref (anonymization guarantee)', () => {
    const labeled = anonymizeForReview(
      SOL,
      [
        { seatRef: SOL, text: 'mine' },
        { seatRef: GEM, text: 'gemini said this' },
        { seatRef: GROK, text: 'grok said that' }
      ],
      [0, 1]
    )
    const prompt = buildReviewPrompt(labeled, 'What is 2+2?')
    for (const name of ['gpt-5.6-sol', 'gemini-3.1-pro-preview', 'grok-4.5', 'openai', 'google', 'xai']) {
      expect(prompt).not.toContain(name)
    }
    expect(prompt).toContain('Response A')
    expect(prompt).toContain('Response B')
  })

  it('buildChairPrompt names the seats and resolves each review legend', () => {
    const answers: CouncilSeatAnswer[] = [
      { seatRef: SOL, text: 'sol ans' },
      { seatRef: GEM, text: 'gem ans' }
    ]
    const prompt = buildChairPrompt('Q?', answers, [
      {
        reviewerRef: GROK,
        text: 'Response A is best',
        mapping: [{ label: 'A', seatRef: SOL, text: 'sol ans' }]
      }
    ])
    expect(prompt).toContain(seatLabel(SOL))
    expect(prompt).toContain(seatLabel(GEM))
    expect(prompt).toContain(`Review by ${seatLabel(GROK)}`)
    expect(prompt).toContain(`Response A = ${seatLabel(SOL)}`)
  })
})

// Ursus convenes the SAME runner with its own seats/chair -- the whole point of
// CouncilConfig. These refs are deliberately a different provider entirely from
// Ursa's, so a config leak would be unmissable.
const U_SEAT_A = 'openrouter/moonshotai/kimi-k3'
const U_SEAT_B = 'openrouter/z-ai/glm-5.2'
const U_SEAT_C = 'openrouter/minimax/minimax-m3'
const U_CHAIR = 'openrouter/deepseek/deepseek-v4-pro'
const URSUS_CFG: CouncilConfig = {
  seats: [U_SEAT_A, U_SEAT_B, U_SEAT_C],
  chair: U_CHAIR,
  unavailable: 'ursus council unavailable'
}

describe('runCouncil — honors a non-Ursa CouncilConfig', () => {
  it('seats and chairs on the supplied config, never Ursa\'s models', async () => {
    vi.mocked(keyStatus).mockReturnValue(keyed())
    const models: Record<string, unknown> = {
      [U_SEAT_A]: seatModel('a'),
      [U_SEAT_B]: seatModel('b'),
      [U_SEAT_C]: seatModel('c'),
      [U_CHAIR]: chairModel(['Ursus ', 'synthesis'])
    }
    vi.mocked(makeModel).mockImplementation((ref: string) => {
      const m = models[ref]
      if (!m) throw new Error(`unexpected model constructed: ${ref}`)
      return m as never
    })

    const sink = makeSink()
    const result = await runCouncil('c1', 'Q?', sink, new AbortController().signal, URSUS_CFG)
    expect(result).toEqual({ paused: false })

    // Every constructed model came from the Ursus config.
    const built = vi.mocked(makeModel).mock.calls.map((c) => c[0])
    expect(new Set(built)).toEqual(new Set([U_SEAT_A, U_SEAT_B, U_SEAT_C, U_CHAIR]))
    for (const ref of built) expect(COUNCIL_SEATS).not.toContain(ref)

    // turn_meta books the Ursus chair, not Ursa's.
    const meta = emitted(sink).find((e) => e.type === 'turn_meta')
    expect(meta && meta.type === 'turn_meta' && meta.provider).toBe('openrouter')
    expect(meta && meta.type === 'turn_meta' && meta.model).toBe('deepseek/deepseek-v4-pro')
  })

  it('surfaces the config\'s own unavailable message when its seats are unkeyed', async () => {
    vi.mocked(keyStatus).mockReturnValue(keyed({ openrouter: false }))
    const sink = makeSink()
    const result = await runCouncil('c1', 'Q?', sink, new AbortController().signal, URSUS_CFG)
    expect(result).toEqual({ paused: false, failed: true })
    const err = emitted(sink).find((e) => e.type === 'error')
    expect(err && err.type === 'error' && err.message).toBe('ursus council unavailable')
  })

  it('defaults to Ursa\'s council when no config is passed', async () => {
    expect(URSA_COUNCIL.seats).toBe(COUNCIL_SEATS)
    vi.mocked(keyStatus).mockReturnValue(keyed())
    const models: Record<string, unknown> = {
      [SOL]: seatModel('sol'),
      [GEM]: seatModel('gem'),
      [GROK]: seatModel('grok'),
      [CHAIR]: chairModel()
    }
    vi.mocked(makeModel).mockImplementation((ref: string) => models[ref] as never)
    const sink = makeSink()
    await runCouncil('c1', 'Q?', sink, new AbortController().signal)
    const built = vi.mocked(makeModel).mock.calls.map((c) => c[0])
    expect(built).toContain(CHAIR)
  })
})

describe('runCouncil — happy path (3 seats, 3 reviews, chair streams)', () => {
  it('emits ordered answer/review events, streams the chair, and books full usage', async () => {
    vi.mocked(keyStatus).mockReturnValue(keyed())
    const models: Record<string, unknown> = {
      [SOL]: seatModel('sol'),
      [GEM]: seatModel('gem'),
      [GROK]: seatModel('grok'),
      [CHAIR]: chairModel(['Synth ', 'answer'])
    }
    vi.mocked(makeModel).mockImplementation((ref: string) => models[ref] as never)

    const sink = makeSink()
    const result = await runCouncil('c1', 'What is X?', sink, new AbortController().signal)
    expect(result).toEqual({ paused: false })

    const evs = emitted(sink)
    const answerEvs = evs.filter((e) => e.type === 'council_seat' && e.stage === 'answer')
    const reviewEvs = evs.filter((e) => e.type === 'council_seat' && e.stage === 'review')
    expect(answerEvs).toHaveLength(3)
    expect(reviewEvs).toHaveLength(3)
    expect(answerEvs.every((e) => e.type === 'council_seat' && e.status === 'done')).toBe(true)

    // Stage ordering: every answer before every review before the chair's turn_meta.
    const idx = (pred: (e: Event) => boolean): number => evs.findIndex(pred)
    const lastAnswer = evs.map(pred_answer).lastIndexOf(true)
    const firstReview = idx((e) => e.type === 'council_seat' && e.stage === 'review')
    const metaIdx = idx((e) => e.type === 'turn_meta')
    expect(lastAnswer).toBeLessThan(firstReview)
    expect(firstReview).toBeLessThan(metaIdx)

    // Chair streamed the answer as normal assistant_text (upserted by one id).
    const textEvs = emitted(sink).filter((e) => e.type === 'assistant_text')
    expect(textEvs.length).toBeGreaterThan(0)
    const finalText = textEvs[textEvs.length - 1]
    expect(finalText.type === 'assistant_text' && finalText.text).toBe('Synth answer')

    const meta = evs.find((e) => e.type === 'turn_meta')
    expect(meta).toBeDefined()
    if (meta?.type !== 'turn_meta') throw new Error('no meta')
    expect(meta.ursaRole).toBe('council')
    expect(meta.provider).toBe('anthropic')
    expect(meta.model).toBe('claude-fable-5')
    // Chair usage rides the normal slot.
    expect(meta.usage).toEqual({ inputTokens: 100, outputTokens: 50, lastInputTokens: 100 })
    // One ursaCouncilUsage entry per seat call: 3 answers + 3 reviews = 6.
    expect(meta.ursaCouncilUsage).toHaveLength(6)
    expect(meta.ursaCouncilUsage?.every((u) => u.inputTokens === 10 && u.outputTokens === 5)).toBe(true)

    expect(sink.setState).toHaveBeenLastCalledWith('c1', 'done')
  })
})

// Helper predicate hoisted for the lastIndexOf trick above.
function pred_answer(e: Event): boolean {
  return e.type === 'council_seat' && e.stage === 'answer'
}

describe('runCouncil — degradation and gating', () => {
  it('with a single keyed seat, skips the review stage but still runs the chair', async () => {
    vi.mocked(keyStatus).mockReturnValue(keyed({ google: false, xai: false }))
    const models: Record<string, unknown> = {
      [SOL]: seatModel('sol'),
      [CHAIR]: chairModel()
    }
    vi.mocked(makeModel).mockImplementation((ref: string) => models[ref] as never)

    const sink = makeSink()
    const result = await runCouncil('c1', 'Q', sink, new AbortController().signal)
    expect(result).toEqual({ paused: false })

    const evs = emitted(sink)
    expect(evs.filter((e) => e.type === 'council_seat' && e.stage === 'answer')).toHaveLength(1)
    expect(evs.filter((e) => e.type === 'council_seat' && e.stage === 'review')).toHaveLength(0)
    const meta = evs.find((e) => e.type === 'turn_meta')
    if (meta?.type !== 'turn_meta') throw new Error('no meta')
    // Only the single seat's ANSWER call is booked (no reviews).
    expect(meta.ursaCouncilUsage).toHaveLength(1)
    expect(sink.setState).toHaveBeenLastCalledWith('c1', 'done')
  })

  it('a failed seat answer emits status:failed and drops that seat from later stages', async () => {
    vi.mocked(keyStatus).mockReturnValue(keyed())
    const brokenGrok = {
      invoke: vi.fn(async () => {
        throw new Error('grok 500')
      })
    }
    // Capture the chair prompt to assert the failed seat is absent from it.
    const chair = chairModel()
    const models: Record<string, unknown> = {
      [SOL]: seatModel('sol'),
      [GEM]: seatModel('gem'),
      [GROK]: brokenGrok,
      [CHAIR]: chair
    }
    vi.mocked(makeModel).mockImplementation((ref: string) => models[ref] as never)

    const sink = makeSink()
    const result = await runCouncil('c1', 'Q', sink, new AbortController().signal)
    expect(result).toEqual({ paused: false })

    const evs = emitted(sink)
    const failed = evs.find(
      (e) => e.type === 'council_seat' && e.stage === 'answer' && e.status === 'failed'
    )
    expect(failed).toBeDefined()
    expect(failed?.type === 'council_seat' && failed.modelRef).toBe(GROK)
    // Two surviving answers => two reviews, not three.
    expect(evs.filter((e) => e.type === 'council_seat' && e.stage === 'review')).toHaveLength(2)
    // The chair never saw the failed seat.
    const chairMsgs = chair.stream.mock.calls[0][0] as Array<{ content: unknown }>
    const chairPrompt = String(chairMsgs[1].content)
    expect(chairPrompt).not.toContain(seatLabel(GROK))
    expect(chairPrompt).toContain(seatLabel(SOL))
    expect(sink.setState).toHaveBeenLastCalledWith('c1', 'done')
  })

  it('errors honestly (no chair call) when no seat is keyed', async () => {
    vi.mocked(keyStatus).mockReturnValue(keyed({ openai: false, google: false, xai: false }))
    const sink = makeSink()
    const result = await runCouncil('c1', 'Q', sink, new AbortController().signal)
    expect(result).toEqual({ paused: false, failed: true })
    expect(makeModel).not.toHaveBeenCalled()
    const evs = emitted(sink)
    expect(evs.some((e) => e.type === 'error')).toBe(true)
    expect(evs.some((e) => e.type === 'turn_meta')).toBe(false)
    expect(sink.setState).toHaveBeenLastCalledWith('c1', 'error')
  })

  it('errors honestly (no seat call) when the chair provider is unkeyed', async () => {
    vi.mocked(keyStatus).mockReturnValue(keyed({ anthropic: false }))
    const sink = makeSink()
    const result = await runCouncil('c1', 'Q', sink, new AbortController().signal)
    expect(result).toEqual({ paused: false, failed: true })
    expect(makeModel).not.toHaveBeenCalled()
    expect(sink.setState).toHaveBeenLastCalledWith('c1', 'error')
  })

  it('errors when every seat fails to answer (no chair synthesis)', async () => {
    vi.mocked(keyStatus).mockReturnValue(keyed())
    const broken = { invoke: vi.fn(async () => { throw new Error('down') }) }
    const chair = chairModel()
    const models: Record<string, unknown> = {
      [SOL]: broken,
      [GEM]: broken,
      [GROK]: broken,
      [CHAIR]: chair
    }
    vi.mocked(makeModel).mockImplementation((ref: string) => models[ref] as never)
    const sink = makeSink()
    const result = await runCouncil('c1', 'Q', sink, new AbortController().signal)
    expect(result).toEqual({ paused: false, failed: true })
    expect(chair.stream).not.toHaveBeenCalled()
    expect(sink.setState).toHaveBeenLastCalledWith('c1', 'error')
  })

  it('aborts to cancelled state when the signal is already aborted', async () => {
    vi.mocked(keyStatus).mockReturnValue(keyed())
    const controller = new AbortController()
    controller.abort()
    const models: Record<string, unknown> = {
      [SOL]: seatModel('sol', controller.signal),
      [GEM]: seatModel('gem', controller.signal),
      [GROK]: seatModel('grok', controller.signal),
      [CHAIR]: chairModel()
    }
    vi.mocked(makeModel).mockImplementation((ref: string) => models[ref] as never)
    const sink = makeSink()
    const result = await runCouncil('c1', 'Q', sink, controller.signal)
    expect(result).toEqual({ paused: false, failed: true })
    expect(sink.setState).toHaveBeenLastCalledWith('c1', 'cancelled')
    // The error event says "Cancelled", never a raw stack.
    const err = emitted(sink).find((e) => e.type === 'error')
    expect(err?.type === 'error' && err.message).toBe('Cancelled')
  })
})
