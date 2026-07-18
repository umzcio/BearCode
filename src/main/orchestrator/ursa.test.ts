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

import { getSettings } from '../settings'

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
})
