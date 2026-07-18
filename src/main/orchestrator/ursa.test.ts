import { describe, it, expect, vi, beforeEach } from 'vitest'
import { URSA_MODEL_REF, isUrsaModelRef, resolveUrsaModelRef } from './ursa'

const invokeSpy = vi.hoisted(() => vi.fn())
vi.mock('./models', () => ({
  makeModel: vi.fn(() => ({
    withStructuredOutput: () => ({ invoke: invokeSpy })
  }))
}))
vi.mock('../settings', () => ({
  getSettings: vi.fn()
}))
vi.mock('../keys', () => ({
  keyStatus: vi.fn(() => ({ anthropic: true, openai: true, google: true, openrouter: true }))
}))
vi.mock('../db', () => ({
  listConversations: vi.fn(() => []),
  getEvents: vi.fn(() => [])
}))

import { getSettings } from '../settings'
import { listConversations, getEvents } from '../db'

describe('isUrsaModelRef', () => {
  it('matches only the sentinel', () => {
    expect(isUrsaModelRef(URSA_MODEL_REF)).toBe(true)
    expect(isUrsaModelRef('anthropic/claude-sonnet-5')).toBe(false)
  })
})

describe('resolveUrsaModelRef', () => {
  const roles = [
    { name: 'coder', modelRef: 'openai/gpt-5.6-sol', description: 'Writes code' },
    { name: 'grunt', modelRef: 'anthropic/claude-haiku-4-5', description: 'Simple review tasks' }
  ]

  beforeEach(() => {
    invokeSpy.mockReset()
    vi.mocked(getSettings).mockReturnValue({
      ursaRoles: roles,
      ursaGuardrails: { roleCeilings: {} }
    } as never)
  })

  it("resolves to the classifier-chosen role's modelRef", async () => {
    invokeSpy.mockResolvedValue({ role: 'coder' })
    const result = await resolveUrsaModelRef({ userText: 'refactor this module', projectPath: null })
    expect(result).toEqual({ modelRef: 'openai/gpt-5.6-sol', roleName: 'coder' })
  })

  it('throws when no roles are configured', async () => {
    vi.mocked(getSettings).mockReturnValue({
      ursaRoles: [],
      ursaGuardrails: { roleCeilings: {} }
    } as never)
    await expect(resolveUrsaModelRef({ userText: 'hi', projectPath: null })).rejects.toThrow(
      /no roles configured/i
    )
  })

  it('falls back to the first eligible role if the classifier names an unknown role', async () => {
    invokeSpy.mockResolvedValue({ role: 'nonexistent-role' })
    const result = await resolveUrsaModelRef({ userText: 'hi', projectPath: null })
    expect(result).toEqual({ modelRef: 'openai/gpt-5.6-sol', roleName: 'coder' })
  })

  it('flags needsConsent when the resolved role has crossed its cost ceiling', async () => {
    invokeSpy.mockResolvedValue({ role: 'coder' })
    vi.mocked(getSettings).mockReturnValue({
      ursaRoles: roles,
      ursaGuardrails: { roleCeilings: { coder: 0.01 } }
    } as never)
    // A single prior turn under the 'coder' role in this project ran on a
    // bundled-priced model with enough output tokens to cost ~$0.05 -- well
    // over the $0.01 ceiling. (Deviation from plan: the plan mocked an
    // internal projectSpendForRole; that isn't a separate module, so we feed
    // the real spend aggregation through the real db + pricing path instead --
    // haiku's bundled $5/1M output * 10k tokens = $0.05.)
    vi.mocked(listConversations).mockReturnValue([{ id: 'c1', projectPath: '/tmp/proj' }] as never)
    vi.mocked(getEvents).mockReturnValue([
      {
        type: 'turn_meta',
        id: 't1',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        startedAt: 0,
        endedAt: 1,
        ursaRole: 'coder',
        usage: { inputTokens: 0, outputTokens: 10_000, lastInputTokens: 0 }
      }
    ] as never)
    const result = await resolveUrsaModelRef({ userText: 'refactor this', projectPath: '/tmp/proj' })
    expect(result).toEqual({
      needsConsent: {
        roleName: 'coder',
        modelRef: 'openai/gpt-5.6-sol',
        reason: expect.stringContaining('budget')
      }
    })
  })
})
