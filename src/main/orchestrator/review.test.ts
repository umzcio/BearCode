import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../db', () => ({ getRecentUrsaContext: vi.fn(() => ''), appendEvent: vi.fn(), getConversationMeta: vi.fn(() => ({ id: 'c1', title: 't' })) }))
vi.mock('../keys', () => ({ keyStatus: vi.fn(() => ({ anthropic: true, openai: true, xai: true, openrouter: true })) }))
const invokeSpy = vi.hoisted(() => vi.fn())
vi.mock('./models', () => ({ makeModel: vi.fn(() => ({ withStructuredOutput: () => ({ invoke: invokeSpy }) })) }))
vi.mock('../title', () => ({ CHEAP_MODEL: { anthropic: 'claude-haiku-4-5', openai: 'gpt-5.6-luna', openrouter: 'deepseek/deepseek-chat' } }))

import { URSA_REVIEW_PANEL, rubricFor, resolveReviewRequest } from './review'
import { URSUS_REVIEW_PANEL } from './ursus'

describe('review panels', () => {
  it('Ursa panel: 3 diverse seats + Sonnet chair, chair not a seat', () => {
    expect(URSA_REVIEW_PANEL.seats).toEqual([
      'anthropic/claude-fable-5', 'openai/gpt-5.6-sol', 'xai/grok-4.5'
    ])
    expect(URSA_REVIEW_PANEL.chair).toBe('anthropic/claude-sonnet-5')
    expect(URSA_REVIEW_PANEL.seats).not.toContain(URSA_REVIEW_PANEL.chair)
    expect(URSA_REVIEW_PANEL.unavailable).toMatch(/Anthropic/i)
  })
  it('Ursus panel rides entirely on openrouter', () => {
    for (const r of [...URSUS_REVIEW_PANEL.seats, URSUS_REVIEW_PANEL.chair]) {
      expect(r.split('/')[0]).toBe('openrouter')
    }
    expect(URSUS_REVIEW_PANEL.chair).toBe('openrouter/deepseek/deepseek-v4-pro')
  })
})

describe('rubricFor', () => {
  it('returns a distinct non-empty rubric per lens', () => {
    const lenses = ['code','security','accessibility','performance','comprehensive'] as const
    const bodies = lenses.map(rubricFor)
    bodies.forEach((b) => expect(b.length).toBeGreaterThan(20))
    expect(new Set(bodies).size).toBe(bodies.length)          // all different
  })
  it('comprehensive names every lens', () => {
    const c = rubricFor('comprehensive').toLowerCase()
    for (const w of ['security','accessib','performance']) expect(c).toContain(w)
  })
})

describe('resolveReviewRequest', () => {
  beforeEach(() => invokeSpy.mockReset())
  it('passes through an explicit lens + scope from the classifier', async () => {
    invokeSpy.mockResolvedValue({ lens: 'security', scope: 'src/auth' })
    expect(await resolveReviewRequest('audit src/auth for vulns')).toEqual({ lens: 'security', scope: 'src/auth' })
  })
  it('leaves fields undefined when the classifier omits them', async () => {
    invokeSpy.mockResolvedValue({})
    expect(await resolveReviewRequest('review this')).toEqual({ lens: undefined, scope: undefined })
  })
  it('drops an out-of-set lens rather than trusting it', async () => {
    invokeSpy.mockResolvedValue({ lens: 'vibes', scope: 'x' })
    const r = await resolveReviewRequest('x')
    expect(r.lens).toBeUndefined()
    expect(r.scope).toBe('x')
  })
})
