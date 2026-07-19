import { describe, it, expect, vi, beforeEach } from 'vitest'
import { URSA_MODEL_REF, isUrsaModelRef, resolveUrsaModelRef, CURATED_ROLES, ursaRequiredProviders } from './ursa'

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
vi.mock('../title', () => ({
  CHEAP_MODEL: { anthropic: 'claude-haiku-4-5', openai: 'gpt-5.6-luna', google: 'gemini-2.5-flash' }
}))

import { getSettings } from '../settings'
import { keyStatus } from '../keys'
import { makeModel } from './models'
import { CHEAP_MODEL } from '../title'

describe('isUrsaModelRef', () => {
  it('matches only the sentinel', () => {
    expect(isUrsaModelRef(URSA_MODEL_REF)).toBe(true)
    expect(isUrsaModelRef('anthropic/claude-sonnet-5')).toBe(false)
  })
})

describe('CURATED_ROLES', () => {
  it('is a fixed, non-empty, cross-provider table -- not user data', () => {
    expect(CURATED_ROLES.length).toBeGreaterThan(0)
    const providers = new Set(CURATED_ROLES.map((r) => r.modelRef.split('/')[0]))
    expect(providers.size).toBeGreaterThan(1)
  })

  it('ursaRequiredProviders lists every provider a curated role depends on', () => {
    const providers = ursaRequiredProviders()
    for (const role of CURATED_ROLES) {
      expect(providers).toContain(role.modelRef.split('/')[0])
    }
  })
})

describe('resolveUrsaModelRef', () => {
  beforeEach(() => {
    invokeSpy.mockReset()
    vi.mocked(makeModel).mockClear()
    vi.mocked(getSettings).mockReturnValue({ ursaEnabled: true } as never)
    vi.mocked(keyStatus).mockReturnValue({
      anthropic: true,
      openai: true,
      google: true,
      openrouter: true
    } as never)
  })

  it('throws when Ursa is disabled', async () => {
    vi.mocked(getSettings).mockReturnValue({ ursaEnabled: false } as never)
    await expect(resolveUrsaModelRef({ userText: 'hi' })).rejects.toThrow(/disabled/i)
  })

  it('throws when none of the curated roles have a configured key', async () => {
    vi.mocked(keyStatus).mockReturnValue({
      anthropic: false,
      openai: false,
      google: false,
      openrouter: false
    } as never)
    await expect(resolveUrsaModelRef({ userText: 'hi' })).rejects.toThrow(/api key/i)
  })

  it("resolves to the classifier-chosen curated role's modelRef", async () => {
    invokeSpy.mockResolvedValue({ role: 'coder' })
    const coder = CURATED_ROLES.find((r) => r.name === 'coder')!
    const result = await resolveUrsaModelRef({ userText: 'refactor this module' })
    expect(result).toEqual({ modelRef: coder.modelRef, roleName: 'coder' })
  })

  it('falls back to the first eligible role if the classifier names an unknown role', async () => {
    invokeSpy.mockResolvedValue({ role: 'nonexistent-role' })
    const first = CURATED_ROLES[0]
    const result = await resolveUrsaModelRef({ userText: 'hi' })
    expect(result).toEqual({ modelRef: first.modelRef, roleName: first.name })
  })

  it('falls back to the first eligible role if the classifier call throws', async () => {
    invokeSpy.mockRejectedValue(new Error('rate limited'))
    const first = CURATED_ROLES[0]
    const result = await resolveUrsaModelRef({ userText: 'hi' })
    expect(result).toEqual({ modelRef: first.modelRef, roleName: first.name })
  })

  it('excludes a curated role whose provider has no configured key from the eligible set', async () => {
    // Only the provider(s) the 'coder' role needs are missing a key.
    const coder = CURATED_ROLES.find((r) => r.name === 'coder')!
    const coderProvider = coder.modelRef.split('/')[0]
    vi.mocked(keyStatus).mockReturnValue({
      anthropic: true,
      openai: true,
      google: true,
      openrouter: true,
      [coderProvider]: false
    } as never)
    invokeSpy.mockResolvedValue({ role: 'coder' })
    const result = await resolveUrsaModelRef({ userText: 'hi' })
    expect(result.roleName).not.toBe('coder')
  })

  it('skips classification and resolves to the first eligible role, without throwing, when every eligible role\'s provider has a configured key but no CHEAP_MODEL entry', async () => {
    // Only anthropic-backed roles (architect, reviewer) are eligible; simulate
    // anthropic having a key but no cheap-model table entry -- the
    // classifier must never be constructed in this case (that used to be
    // the throw-outside-try/catch bug), and no key/role is missing so
    // eligibleRoles is non-empty (unlike the "no configured key" case).
    vi.mocked(keyStatus).mockReturnValue({
      anthropic: true,
      openai: false,
      google: false,
      openrouter: false
    } as never)
    const savedAnthropic = CHEAP_MODEL.anthropic
    delete (CHEAP_MODEL as Record<string, string | undefined>).anthropic

    try {
      const first = CURATED_ROLES.find((r) => r.modelRef.split('/')[0] === 'anthropic')!
      const result = await resolveUrsaModelRef({ userText: 'hi' })
      expect(result).toEqual({ modelRef: first.modelRef, roleName: first.name })
      expect(makeModel).not.toHaveBeenCalled()
      expect(invokeSpy).not.toHaveBeenCalled()
    } finally {
      ;(CHEAP_MODEL as Record<string, string | undefined>).anthropic = savedAnthropic
    }
  })

  it('degrades to the first eligible role, without throwing, when makeModel itself throws', async () => {
    vi.mocked(makeModel).mockImplementationOnce(() => {
      throw new Error('no provider client configured')
    })
    const first = CURATED_ROLES[0]
    const result = await resolveUrsaModelRef({ userText: 'hi' })
    expect(result).toEqual({ modelRef: first.modelRef, roleName: first.name })
  })
})
