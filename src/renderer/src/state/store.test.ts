import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BearcodeApi, ConversationMeta, Event, PermissionRulesInfo } from '@shared/types'
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
  get: vi.fn(() => Promise.resolve([])),
  clear: vi.fn(() => Promise.resolve())
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
  it('a late rejection of an earlier pick does not clobber a newer accepted pick', async () => {
    // Two rapid picks: A ('fast') is left pending, B ('planning') resolves,
    // THEN A rejects. A's catch must see that its optimistic value is no
    // longer current and skip both the revert and the toast -- otherwise B's
    // persisted value would be clobbered with A's stale prior plus a
    // misleading locked message.
    let rejectA: (err: Error) => void = () => {}
    conversations.setExecutionMode
      .mockImplementationOnce(
        () =>
          new Promise<void>((_, reject) => {
            rejectA = reject
          })
      )
      .mockImplementationOnce(() => Promise.resolve())
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      conversations: { c1: convo() },
      executionMode: 'planning',
      toast: null
    })
    useAppStore.getState().setExecutionMode('fast') // pick A, pending
    useAppStore.getState().setExecutionMode('planning') // pick B, accepted
    await Promise.resolve() // let B's resolution settle
    rejectA(new Error('Execution mode is locked after the first turn'))
    await Promise.resolve()
    await Promise.resolve() // let A's catch run
    expect(conversations.setExecutionMode).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().executionMode).toBe('planning')
    expect(useAppStore.getState().conversations.c1.executionMode).toBe('planning')
    expect(useAppStore.getState().toast).toBeNull()
  })
  it('strips the Electron IPC wrapper from the lock toast (Ba3 follow-up)', async () => {
    conversations.setExecutionMode.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'bearcode:conversations:set-execution-mode': " +
          'Error: Execution mode is locked after the first turn'
      )
    )
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      conversations: { c1: convo() },
      executionMode: 'planning',
      toast: null
    })
    useAppStore.getState().setExecutionMode('fast')
    await vi.waitFor(() =>
      expect(useAppStore.getState().toast).toBe('Execution mode is locked after the first turn')
    )
    expect(useAppStore.getState().executionMode).toBe('planning')
  })
  it('navigating home during a pending pick still reverts the stranded convo patch', async () => {
    // The strand (Ba3 FINAL follow-up): the composer resets on goHome, so a
    // whole-action staleness guard would bail and leave the optimistic convo
    // patch describing a mode main rejected -- which openConvo would then
    // re-adopt forever. The per-field guard reverts the patch anyway.
    let rejectPick: (err: Error) => void = () => {}
    conversations.setExecutionMode.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          rejectPick = reject
        })
    )
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      conversations: { c1: convo({ executionMode: 'fast' }) },
      executionMode: 'fast',
      settings: {
        ollamaBaseUrl: '',
        defaultModelRef: null,
        defaultPermissionMode: 'accept-edits',
        disabledBuiltins: [],
        artifactReviewPolicy: 'request-review',
        defaultExecutionMode: 'planning',
        dataPath: '/tmp'
      },
      toast: null
    })
    useAppStore.getState().setExecutionMode('planning') // optimistic patch lands, IPC pending
    useAppStore.getState().goHome() // composer resets to the default ('planning')
    rejectPick(new Error('Execution mode is locked after the first turn'))
    await vi.waitFor(() =>
      expect(useAppStore.getState().conversations.c1.executionMode).toBe('fast')
    )
    // The composer belongs to Home now -- untouched by the revert.
    expect(useAppStore.getState().executionMode).toBe('planning')
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

describe('auxiliary pane selection (Ba4): one field, deep-link ticks, reset on switch', () => {
  const diffEvent = {
    type: 'file_diff',
    id: 'ev-d1',
    diffId: 'd1',
    files: [{ path: 'src/a.ts', additions: 3, deletions: 1, status: 'modified' }]
  } as Event

  it('openArtifactPane selects the artifact, clears focusPath, bumps the open tick', () => {
    useAppStore.setState({ auxSelection: null, auxPaneOpenTick: 0, reviewFocusPath: 'stale' })
    useAppStore.getState().openArtifactPane('a1')
    expect(useAppStore.getState().auxSelection).toEqual({ kind: 'artifact', artifactId: 'a1' })
    expect(useAppStore.getState().auxPaneOpenTick).toBe(1)
    expect(useAppStore.getState().reviewFocusPath).toBeNull()
  })
  it('openReview selects the diff (structurally closing any artifact) and bumps the tick', () => {
    useAppStore.setState({
      auxSelection: { kind: 'artifact', artifactId: 'a1' },
      auxPaneOpenTick: 0
    })
    useAppStore.getState().openReview('d1')
    expect(useAppStore.getState().auxSelection).toEqual({ kind: 'diff', diffId: 'd1' })
    expect(useAppStore.getState().auxPaneOpenTick).toBe(1)
  })
  it('openReviewForFile finds the newest diff containing the file and focuses it', () => {
    useAppStore.setState({
      conversations: { c1: convo({ events: [diffEvent] }) },
      auxSelection: null,
      auxPaneOpenTick: 0
    })
    useAppStore.getState().openReviewForFile('c1', 'src/a.ts')
    expect(useAppStore.getState().auxSelection).toEqual({ kind: 'diff', diffId: 'd1' })
    expect(useAppStore.getState().reviewFocusPath).toBe('src/a.ts')
    expect(useAppStore.getState().auxPaneOpenTick).toBe(1)
  })
  it('switching to a DIFFERENT conversation closes the pane; re-opening the same one keeps it', () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      conversations: { c1: convo(), c2: convo({ id: 'c2' }) },
      auxSelection: { kind: 'diff', diffId: 'd1' },
      reviewFocusPath: 'src/a.ts'
    })
    useAppStore.getState().openConvo('c1') // same target: pane survives
    expect(useAppStore.getState().auxSelection).toEqual({ kind: 'diff', diffId: 'd1' })
    useAppStore.getState().openConvo('c2') // real switch: pane closes
    expect(useAppStore.getState().auxSelection).toBeNull()
    expect(useAppStore.getState().reviewFocusPath).toBeNull()
  })
  it('goHome and closeReview both clear the selection', () => {
    useAppStore.setState({ auxSelection: { kind: 'artifact', artifactId: 'a1' } })
    useAppStore.getState().goHome()
    expect(useAppStore.getState().auxSelection).toBeNull()
    useAppStore.setState({ auxSelection: { kind: 'diff', diffId: 'd1' }, reviewFocusPath: 'x' })
    useAppStore.getState().closeReview()
    expect(useAppStore.getState().auxSelection).toBeNull()
    expect(useAppStore.getState().reviewFocusPath).toBeNull()
  })
  it('deleteAllConversations closes the pane with everything else', async () => {
    useAppStore.setState({ auxSelection: { kind: 'diff', diffId: 'd1' } })
    await useAppStore.getState().deleteAllConversations()
    expect(useAppStore.getState().auxSelection).toBeNull()
  })
})
