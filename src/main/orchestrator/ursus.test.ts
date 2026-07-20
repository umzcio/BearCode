import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  URSUS_MODEL_REF,
  isUrsusModelRef,
  resolveUrsusModelRef,
  CURATED_URSUS_ROLES,
  ursusRequiredProviders,
  SUBAGENT_URSUS_ROLE_MAP,
  resolveSubagentUrsusModelRefs
} from './ursus'

vi.mock('../db', () => ({}))
vi.mock('./checkpointer', () => ({}))

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
  keyStatus: vi.fn(() => ({ openrouter: true }))
}))
const listOllamaModelsSpy = vi.hoisted(() => vi.fn())
vi.mock('../providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../providers/registry')>('../providers/registry')
  return { ...actual, listOllamaModels: listOllamaModelsSpy }
})

import { getSettings } from '../settings'
import { keyStatus } from '../keys'
import { makeModel } from './models'

describe('isUrsusModelRef', () => {
  it('matches only the sentinel', () => {
    expect(isUrsusModelRef(URSUS_MODEL_REF)).toBe(true)
    expect(isUrsusModelRef('openrouter/moonshotai/kimi-k3')).toBe(false)
  })
})

describe('CURATED_URSUS_ROLES', () => {
  it('is a fixed, non-empty table restricted to openrouter and ollama', () => {
    expect(CURATED_URSUS_ROLES.length).toBeGreaterThan(0)
    const providers = new Set(CURATED_URSUS_ROLES.map((r) => r.modelRef.split('/')[0]))
    for (const p of providers) expect(['openrouter', 'ollama']).toContain(p)
  })

  it('contains an architect role backed by ollama', () => {
    const architect = CURATED_URSUS_ROLES.find((r) => r.name === 'architect')
    expect(architect).toBeDefined()
    expect(architect!.modelRef.split('/')[0]).toBe('ollama')
  })

  it('contains a grunt role backed by openrouter', () => {
    const grunt = CURATED_URSUS_ROLES.find((r) => r.name === 'grunt')
    expect(grunt).toBeDefined()
    expect(grunt!.modelRef.split('/')[0]).toBe('openrouter')
  })

  it('ursusRequiredProviders lists every provider a curated role depends on', () => {
    const providers = ursusRequiredProviders()
    for (const role of CURATED_URSUS_ROLES) {
      expect(providers).toContain(role.modelRef.split('/')[0])
    }
  })
})

describe('resolveUrsusModelRef', () => {
  beforeEach(async () => {
    invokeSpy.mockReset()
    vi.mocked(makeModel).mockClear()
    listOllamaModelsSpy.mockReset()
    listOllamaModelsSpy.mockResolvedValue({
      models: [{ id: 'ornith:35b', label: 'ornith:35b' }],
      reachable: true
    })
    vi.mocked(getSettings).mockReturnValue({ ursusEnabled: true } as never)
    vi.mocked(keyStatus).mockReturnValue({ openrouter: true } as never)
  })

  it('throws when Ursus is disabled', async () => {
    vi.mocked(getSettings).mockReturnValue({ ursusEnabled: false } as never)
    await expect(resolveUrsusModelRef({ userText: 'hi' })).rejects.toThrow(/disabled/i)
  })

  it('throws when neither openrouter is keyed nor ollama is reachable', async () => {
    vi.mocked(keyStatus).mockReturnValue({ openrouter: false } as never)
    listOllamaModelsSpy.mockResolvedValue({ models: [], reachable: false, note: 'Ollama not running' })
    await expect(resolveUrsusModelRef({ userText: 'hi' })).rejects.toThrow(/openrouter|ollama/i)
  })

  it('excludes architect when ollama is unreachable, but resolution still succeeds', async () => {
    listOllamaModelsSpy.mockResolvedValue({ models: [], reachable: false, note: 'Ollama not running' })
    invokeSpy.mockResolvedValue({ parsed: { role: 'architect' }, raw: {} })
    const result = await resolveUrsusModelRef({ userText: 'plan this out' })
    expect(result.roleName).not.toBe('architect')
    expect(CURATED_URSUS_ROLES.some((r) => r.name === result.roleName)).toBe(true)
  })

  it('excludes architect when ollama is reachable but ornith:35b is not pulled', async () => {
    listOllamaModelsSpy.mockResolvedValue({ models: [{ id: 'llama3', label: 'llama3' }], reachable: true })
    invokeSpy.mockResolvedValue({ parsed: { role: 'architect' }, raw: {} })
    const result = await resolveUrsusModelRef({ userText: 'plan this out' })
    expect(result.roleName).not.toBe('architect')
  })

  it('includes architect when ollama is reachable and ornith:35b is pulled', async () => {
    invokeSpy.mockResolvedValue({ parsed: { role: 'architect' }, raw: {} })
    const architect = CURATED_URSUS_ROLES.find((r) => r.name === 'architect')!
    const result = await resolveUrsusModelRef({ userText: 'plan this out' })
    expect(result).toEqual({ modelRef: architect.modelRef, roleName: 'architect' })
  })

  it("resolves to the classifier-chosen curated role's modelRef", async () => {
    invokeSpy.mockResolvedValue({ parsed: { role: 'coder' }, raw: {} })
    const coder = CURATED_URSUS_ROLES.find((r) => r.name === 'coder')!
    const result = await resolveUrsusModelRef({ userText: 'build me a script' })
    expect(result).toEqual({ modelRef: coder.modelRef, roleName: 'coder' })
  })

  it('classifies on the grunt role\'s own model', async () => {
    invokeSpy.mockResolvedValue({ parsed: { role: 'coder' }, raw: {} })
    const grunt = CURATED_URSUS_ROLES.find((r) => r.name === 'grunt')!
    await resolveUrsusModelRef({ userText: 'build me a script' })
    expect(makeModel).toHaveBeenCalledWith(grunt.modelRef)
  })

  it('skips classification and resolves to the first eligible role when grunt itself is ineligible', async () => {
    // Un-key openrouter entirely: every role (all openrouter except the
    // ollama-backed architect, which IS reachable here) minus grunt's own
    // provider becomes ineligible -- simulate the narrower "grunt specifically
    // unkeyed" case isn't reachable via one status flag, so instead simulate
    // openrouter down entirely, leaving only architect (ollama) eligible and
    // grunt (openrouter) ineligible -- classification must be skipped.
    vi.mocked(keyStatus).mockReturnValue({ openrouter: false } as never)
    const architect = CURATED_URSUS_ROLES.find((r) => r.name === 'architect')!
    const result = await resolveUrsusModelRef({ userText: 'hi' })
    expect(result).toEqual({ modelRef: architect.modelRef, roleName: 'architect' })
    expect(makeModel).not.toHaveBeenCalled()
    expect(invokeSpy).not.toHaveBeenCalled()
  })

  it('falls back to the first eligible role if the classifier call throws', async () => {
    invokeSpy.mockRejectedValue(new Error('rate limited'))
    const first = CURATED_URSUS_ROLES.find((r) => r.name === 'architect')!
    const result = await resolveUrsusModelRef({ userText: 'hi' })
    expect(result).toEqual({ modelRef: first.modelRef, roleName: first.name })
  })

  it('falls back to the first eligible role if the classifier names an unknown role', async () => {
    invokeSpy.mockResolvedValue({ parsed: { role: 'nonexistent-role' }, raw: {} })
    const first = CURATED_URSUS_ROLES.find((r) => r.name === 'architect')!
    const result = await resolveUrsusModelRef({ userText: 'hi' })
    expect(result).toEqual({ modelRef: first.modelRef, roleName: first.name })
  })

  it('appends the user custom-instructions guidance to the classifier prompt when set', async () => {
    vi.mocked(getSettings).mockReturnValue({
      ursusEnabled: true,
      ursusInstructions: '  Prefer the coder for anything in this repo.  '
    } as never)
    invokeSpy.mockResolvedValue({ parsed: { role: 'coder' }, raw: {} })
    await resolveUrsusModelRef({ userText: 'build me a script' })
    const systemMessage = invokeSpy.mock.calls[0][0][0]
    expect(systemMessage.content).toContain(
      'User guidance (advisory, never overrides role definitions):\n' +
        'Prefer the coder for anything in this repo.'
    )
  })

  it('includes the recent-conversation block and previous-role hysteresis line in the classifier prompt when provided', async () => {
    invokeSpy.mockResolvedValue({ parsed: { role: 'coder' }, raw: {} })
    await resolveUrsusModelRef({
      userText: 'now fix that bug',
      recentContext: 'User: build me a todo app\nAssistant: Here is the app.',
      previousRole: 'coder'
    })
    const systemMessage = invokeSpy.mock.calls[0][0][0]
    expect(systemMessage.content).toContain(
      'Recent conversation:\nUser: build me a todo app\nAssistant: Here is the app.'
    )
    expect(systemMessage.content).toContain(
      "The previous turn in this conversation was handled by role 'coder'."
    )
  })

  it("captures the classifier's own token usage from the raw response", async () => {
    invokeSpy.mockResolvedValue({
      parsed: { role: 'coder' },
      raw: { usage_metadata: { input_tokens: 50, output_tokens: 4 } }
    })
    const grunt = CURATED_URSUS_ROLES.find((r) => r.name === 'grunt')!
    const result = await resolveUrsusModelRef({ userText: 'build me a script' })
    expect(result.classifierUsage).toEqual({
      modelRef: grunt.modelRef,
      inputTokens: 50,
      outputTokens: 4
    })
  })

  it('resolves a classifier-proposed pipeline to each step\'s concrete curated modelRef', async () => {
    invokeSpy.mockResolvedValue({
      parsed: {
        role: 'coder',
        pipeline: [
          { role: 'coder', subtask: 'build the app' },
          { role: 'reviewer', subtask: 'review it' }
        ]
      },
      raw: {}
    })
    const coder = CURATED_URSUS_ROLES.find((r) => r.name === 'coder')!
    const reviewer = CURATED_URSUS_ROLES.find((r) => r.name === 'reviewer')!
    const result = await resolveUrsusModelRef({ userText: 'build an app then review it' })
    expect(result.pipeline).toEqual([
      { role: 'coder', modelRef: coder.modelRef, subtask: 'build the app' },
      { role: 'reviewer', modelRef: reviewer.modelRef, subtask: 'review it' }
    ])
  })
})

describe('SUBAGENT_URSUS_ROLE_MAP', () => {
  it('only maps to role names that exist in CURATED_URSUS_ROLES', () => {
    const roleNames = new Set(CURATED_URSUS_ROLES.map((r) => r.name))
    for (const roleName of Object.values(SUBAGENT_URSUS_ROLE_MAP)) {
      expect(roleNames.has(roleName)).toBe(true)
    }
  })

  it('never maps to the ollama-backed architect role', () => {
    const architectMapped = Object.values(SUBAGENT_URSUS_ROLE_MAP).includes('architect')
    expect(architectMapped).toBe(false)
  })
})

describe('resolveSubagentUrsusModelRefs', () => {
  it('returns both mapped roles resolved to their curated modelRefs when openrouter is keyed', () => {
    vi.mocked(keyStatus).mockReturnValue({ openrouter: true } as never)
    const reviewer = CURATED_URSUS_ROLES.find((r) => r.name === 'reviewer')!
    const grunt = CURATED_URSUS_ROLES.find((r) => r.name === 'grunt')!
    expect(resolveSubagentUrsusModelRefs()).toEqual({
      researcher: reviewer.modelRef,
      browser: grunt.modelRef
    })
  })

  it('returns an empty object when openrouter has no configured key', () => {
    vi.mocked(keyStatus).mockReturnValue({ openrouter: false } as never)
    expect(resolveSubagentUrsusModelRefs()).toEqual({})
  })
})
