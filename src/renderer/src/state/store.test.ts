import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BearcodeApi, ConversationMeta, PermissionRulesInfo } from '@shared/types'
import { useAppStore, type Convo } from './store'

const info: PermissionRulesInfo = {
  userRules: [
    {
      id: 'r1',
      scope: 'global',
      action: 'command',
      match: 'git *',
      effect: 'allow',
      source: 'user'
    }
  ],
  builtins: [
    {
      rule: {
        id: 'builtin:curl-pipe-sh',
        scope: 'global',
        action: 'command',
        match: 'curl * | sh',
        effect: 'deny',
        source: 'builtin'
      },
      disabled: false
    }
  ]
}

const permissions = {
  addRule: vi.fn(() => Promise.resolve()),
  list: vi.fn(() => Promise.resolve(info)),
  deleteRule: vi.fn(() => Promise.resolve()),
  setBuiltinDisabled: vi.fn(() => Promise.resolve())
}

const conversations = {
  create: vi.fn(() => Promise.resolve(convoMeta)),
  setMode: vi.fn(() => Promise.resolve()),
  setExecutionMode: vi.fn(() => Promise.resolve()),
  get: vi.fn(() => Promise.resolve([]))
}
const run = { start: vi.fn(() => Promise.resolve()), cancel: vi.fn(() => Promise.resolve()) }

const convoMeta: ConversationMeta = {
  id: 'c1',
  projectPath: '/tmp/p',
  title: null,
  modelRef: null,
  createdAt: 1,
  updatedAt: 1,
  permissionMode: 'accept-edits',
  executionMode: 'planning'
}

const convo = (over: Partial<Convo> = {}): Convo => ({
  id: 'c1',
  projectPath: '/tmp/p',
  projectLabel: 'p',
  title: 'T',
  modelRef: 'anthropic/claude-sonnet-5',
  permissionMode: 'accept-edits',
  executionMode: 'planning',
  updatedAt: 1,
  loaded: true,
  events: [],
  runState: 'idle',
  ...over
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', {
    bearcode: { permissions, conversations, run } as unknown as BearcodeApi
  })
  useAppStore.setState({ permissionRules: null })
})

describe('permissions manager store actions', () => {
  it('refreshPermissionRules populates permissionRules from the IPC list', async () => {
    await useAppStore.getState().refreshPermissionRules()
    expect(permissions.list).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().permissionRules).toEqual(info)
  })
  it('deletePermissionRule deletes by id, then refreshes', async () => {
    await useAppStore.getState().deletePermissionRule('r1')
    expect(permissions.deleteRule).toHaveBeenCalledWith('r1')
    expect(permissions.list).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().permissionRules).toEqual(info)
  })
  it('setBuiltinDisabled forwards id + flag, then refreshes', async () => {
    await useAppStore.getState().setBuiltinDisabled('builtin:curl-pipe-sh', true)
    expect(permissions.setBuiltinDisabled).toHaveBeenCalledWith('builtin:curl-pipe-sh', true)
    expect(permissions.list).toHaveBeenCalledTimes(1)
  })
  it('addPermissionRule stays fire-and-forget but refreshes once the add lands', async () => {
    useAppStore.getState().addPermissionRule({
      scope: 'global',
      action: 'edit',
      match: '.env.*',
      effect: 'deny'
    })
    await vi.waitFor(() => expect(permissions.list).toHaveBeenCalledTimes(1))
    expect(permissions.addRule).toHaveBeenCalledWith({
      scope: 'global',
      action: 'edit',
      match: '.env.*',
      effect: 'deny'
    })
    expect(useAppStore.getState().permissionRules).toEqual(info)
  })
  it('deletePermissionRule refreshes the list even when the delete fails, then rethrows', async () => {
    permissions.deleteRule.mockRejectedValueOnce(new Error('unknown id'))
    await expect(useAppStore.getState().deletePermissionRule('bogus')).rejects.toThrow('unknown id')
    expect(permissions.list).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().permissionRules).toEqual(info)
  })
  it('setBuiltinDisabled refreshes the list even when the toggle fails, then rethrows', async () => {
    permissions.setBuiltinDisabled.mockRejectedValueOnce(new Error('unknown builtin id'))
    await expect(useAppStore.getState().setBuiltinDisabled('not-a-builtin', true)).rejects.toThrow(
      'unknown builtin id'
    )
    expect(permissions.list).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().permissionRules).toEqual(info)
  })
})

describe('execution mode (Ba3): pick, mirror-lock, persist-before-run', () => {
  it('a Home pick updates the composer value only (no conversation, no IPC)', () => {
    useAppStore.setState({ view: { kind: 'home' }, executionMode: 'planning' })
    useAppStore.getState().setExecutionMode('fast')
    expect(useAppStore.getState().executionMode).toBe('fast')
    expect(conversations.setExecutionMode).not.toHaveBeenCalled()
  })
  it('an unlocked conversation (loaded, zero events) patches the convo and persists over IPC', () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      conversations: { c1: convo() },
      executionMode: 'planning'
    })
    useAppStore.getState().setExecutionMode('fast')
    expect(useAppStore.getState().conversations.c1.executionMode).toBe('fast')
    expect(conversations.setExecutionMode).toHaveBeenCalledWith('c1', 'fast')
  })
  it('LOCK: a conversation with any event ignores the pick entirely', () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      conversations: {
        c1: convo({ events: [{ type: 'user_message', id: 'u1', text: 'hi' }] })
      },
      executionMode: 'planning'
    })
    useAppStore.getState().setExecutionMode('fast')
    expect(useAppStore.getState().executionMode).toBe('planning')
    expect(useAppStore.getState().conversations.c1.executionMode).toBe('planning')
    expect(conversations.setExecutionMode).not.toHaveBeenCalled()
  })
  it('LOCK fails closed: an unloaded conversation (history unknown) counts as locked', () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      conversations: { c1: convo({ loaded: false }) },
      executionMode: 'planning'
    })
    useAppStore.getState().setExecutionMode('fast')
    expect(useAppStore.getState().executionMode).toBe('planning')
    expect(conversations.setExecutionMode).not.toHaveBeenCalled()
  })
  it('reverts the optimistic patch and surfaces the lock when main rejects (broadcast race)', async () => {
    // The window the mirror cannot see: main appended the first user_message
    // (locking) before the broadcast reached the renderer, so the mirror
    // admitted the pick and the IPC then rejected.
    conversations.setExecutionMode.mockRejectedValueOnce(
      new Error('Execution mode is locked after the first turn')
    )
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      conversations: { c1: convo() },
      executionMode: 'planning',
      toast: null
    })
    useAppStore.getState().setExecutionMode('fast')
    // Optimistic first, then reverted on rejection -- never left stale.
    await vi.waitFor(() => expect(useAppStore.getState().executionMode).toBe('planning'))
    expect(useAppStore.getState().conversations.c1.executionMode).toBe('planning')
    expect(useAppStore.getState().toast).toBe('Execution mode is locked after the first turn')
  })
  it('startFromHome persists the picked mode BEFORE the run starts (the pin must find it)', async () => {
    const order: string[] = []
    conversations.setExecutionMode.mockImplementation(() => {
      order.push('setExecutionMode')
      return Promise.resolve()
    })
    run.start.mockImplementation(() => {
      order.push('start')
      return Promise.resolve()
    })
    useAppStore.setState({
      view: { kind: 'home' },
      modelRef: 'anthropic/claude-sonnet-5',
      workspacePath: null,
      executionMode: 'fast'
    })
    useAppStore.getState().startFromHome('hello')
    await vi.waitFor(() => expect(order).toContain('start'))
    expect(conversations.setExecutionMode).toHaveBeenCalledWith('c1', 'fast')
    expect(order.indexOf('setExecutionMode')).toBeLessThan(order.indexOf('start'))
  })
  it('openConvo adopts the conversation mode; goHome resets to the settings default', () => {
    useAppStore.setState({
      conversations: { c1: convo({ executionMode: 'fast' }) },
      executionMode: 'planning',
      settings: {
        ollamaBaseUrl: '',
        defaultModelRef: null,
        defaultPermissionMode: 'accept-edits',
        disabledBuiltins: [],
        artifactReviewPolicy: 'request-review',
        defaultExecutionMode: 'planning',
        dataPath: '/tmp'
      }
    })
    useAppStore.getState().openConvo('c1')
    expect(useAppStore.getState().executionMode).toBe('fast')
    useAppStore.getState().goHome()
    expect(useAppStore.getState().executionMode).toBe('planning')
  })
})
