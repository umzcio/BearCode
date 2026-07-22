// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BearcodeApi, ConversationMeta } from '@shared/types'
import { HERMES_MODEL_REF } from '@shared/types'
import { useAppStore } from './store'

const hermesMeta: ConversationMeta = {
  id: 'h1',
  projectPath: null,
  title: null,
  modelRef: HERMES_MODEL_REF,
  createdAt: 1000,
  updatedAt: 1000,
  permissionMode: 'accept-edits',
  activeRules: [],
  effort: 'adaptive',
  thinking: true,
  webSearch: false,
  projectId: null,
  pinned: false,
  archived: false,
  environment: 'local',
  worktrees: [],
  ursaMode: 'code',
  hermesSessionId: 'sess-1'
}

const conversations = {
  createHermes: vi.fn(() => Promise.resolve(hermesMeta))
}
const hermes = {
  testConnection: vi.fn(() => Promise.resolve({ ok: true, message: 'Connected' })),
  setToken: vi.fn(() => Promise.resolve())
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', {
    bearcode: { conversations, hermes } as unknown as BearcodeApi
  })
  useAppStore.setState({
    view: { kind: 'home' },
    conversations: {},
    convoOrder: []
  })
})

describe('newHermesConversation', () => {
  it('creates a Hermes conversation and opens it', async () => {
    await useAppStore.getState().newHermesConversation()
    expect(conversations.createHermes).toHaveBeenCalledTimes(1)
    const state = useAppStore.getState()
    expect(state.conversations['h1']).toBeDefined()
    expect(state.conversations['h1'].modelRef).toBe(HERMES_MODEL_REF)
    expect(state.convoOrder).toContain('h1')
    expect(state.view).toEqual({ kind: 'conversation', id: 'h1' })
  })

  it('syncs the store top-level modelRef to HERMES_MODEL_REF immediately (not just the per-conversation record)', async () => {
    // Regression: send()/retryRun() dispatch runs using the store's transient
    // top-level modelRef, not the per-conversation one. Without this, a freshly
    // created Hermes conversation would send its first turn under whatever
    // model was last active (or not send at all) until closed and reopened.
    useAppStore.setState({ modelRef: 'anthropic/claude-sonnet-5' })
    await useAppStore.getState().newHermesConversation()
    expect(useAppStore.getState().modelRef).toBe(HERMES_MODEL_REF)
  })
})

describe('testHermesConnection', () => {
  it('delegates to window.bearcode.hermes.testConnection', async () => {
    const result = await useAppStore.getState().testHermesConnection('http://x:8642', 'tok')
    expect(hermes.testConnection).toHaveBeenCalledWith('http://x:8642', 'tok')
    expect(result).toEqual({ ok: true, message: 'Connected' })
  })

  it('works without a token', async () => {
    await useAppStore.getState().testHermesConnection('http://x:8642')
    expect(hermes.testConnection).toHaveBeenCalledWith('http://x:8642', undefined)
  })
})

describe('saveHermesToken', () => {
  it('delegates to window.bearcode.hermes.setToken', async () => {
    await useAppStore.getState().saveHermesToken('new-token')
    expect(hermes.setToken).toHaveBeenCalledWith('new-token')
  })
})
