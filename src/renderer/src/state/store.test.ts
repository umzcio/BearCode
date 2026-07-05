import { describe, it, expect, vi, beforeEach } from 'vitest'
import type {
  BearcodeApi,
  CommandEntry,
  ConversationMeta,
  Event,
  PermissionRulesInfo,
  PlanReviewResolveResult
} from '@shared/types'
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
  get: vi.fn(() => Promise.resolve([])),
  clear: vi.fn(() => Promise.resolve())
}
const run = { start: vi.fn(() => Promise.resolve()), cancel: vi.fn(() => Promise.resolve()) }

const commandEntries: CommandEntry[] = [
  { name: 'goal', description: 'Run until the goal is done.', kind: 'builtin', status: 'live' },
  {
    name: 'release-check',
    description: 'Ship it.',
    kind: 'workflow',
    status: 'live',
    source: 'project'
  }
]
const commands = { list: vi.fn(() => Promise.resolve(commandEntries)) }

const artifacts = {
  resolvePlanReview: vi.fn((): Promise<PlanReviewResolveResult> => Promise.resolve('resolved'))
}

const convoMeta: ConversationMeta = {
  id: 'c1',
  projectPath: '/tmp/p',
  title: null,
  modelRef: null,
  createdAt: 1,
  updatedAt: 1,
  permissionMode: 'accept-edits',
  activeRules: []
}

const convo = (over: Partial<Convo> = {}): Convo => ({
  id: 'c1',
  projectPath: '/tmp/p',
  projectLabel: 'p',
  title: 'T',
  modelRef: 'anthropic/claude-sonnet-5',
  permissionMode: 'accept-edits',
  updatedAt: 1,
  loaded: true,
  events: [],
  runState: 'idle',
  ...over
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', {
    bearcode: { permissions, conversations, run, commands, artifacts } as unknown as BearcodeApi
  })
  useAppStore.setState({ permissionRules: null, commands: [], resumePickerOpen: false })
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

describe('D2 commands: registry fetch, send-path command slot, resume picker', () => {
  const workflowRef = { name: 'release-check', kind: 'workflow' } as const

  it('refreshCommands fetches for the workspace path on Home and populates commands', async () => {
    useAppStore.setState({ view: { kind: 'home' }, workspacePath: '/tmp/ws' })
    useAppStore.getState().refreshCommands()
    await vi.waitFor(() => expect(useAppStore.getState().commands).toEqual(commandEntries))
    expect(commands.list).toHaveBeenCalledWith('/tmp/ws')
  })

  it("refreshCommands fetches for the open conversation's project path", async () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      conversations: { c1: convo({ projectPath: '/tmp/p' }) },
      workspacePath: '/tmp/other'
    })
    useAppStore.getState().refreshCommands()
    await vi.waitFor(() => expect(useAppStore.getState().commands).toEqual(commandEntries))
    expect(commands.list).toHaveBeenCalledWith('/tmp/p')
  })

  it('startFromHome threads the command through to run.start as the fifth argument', async () => {
    useAppStore.setState({
      view: { kind: 'home' },
      modelRef: 'anthropic/claude-sonnet-5',
      workspacePath: null
    })
    useAppStore.getState().startFromHome('do it', workflowRef)
    await vi.waitFor(() => expect(run.start).toHaveBeenCalled())
    expect(run.start).toHaveBeenCalledWith(
      'c1',
      'do it',
      'anthropic/claude-sonnet-5',
      null,
      workflowRef
    )
  })

  it('startFromHome with no command passes null as the fifth argument', async () => {
    useAppStore.setState({
      view: { kind: 'home' },
      modelRef: 'anthropic/claude-sonnet-5',
      workspacePath: null
    })
    useAppStore.getState().startFromHome('hello')
    await vi.waitFor(() => expect(run.start).toHaveBeenCalled())
    expect(run.start).toHaveBeenCalledWith('c1', 'hello', 'anthropic/claude-sonnet-5', null, null)
  })

  it('send threads the command through to run.start as the fifth argument', () => {
    useAppStore.setState({
      modelRef: 'anthropic/claude-sonnet-5',
      conversations: { c1: convo() }
    })
    useAppStore.getState().send('c1', 'do it', workflowRef)
    expect(run.start).toHaveBeenCalledWith(
      'c1',
      'do it',
      'anthropic/claude-sonnet-5',
      '/tmp/p',
      workflowRef
    )
  })

  it('send with no command passes null as the fifth argument', () => {
    useAppStore.setState({
      modelRef: 'anthropic/claude-sonnet-5',
      conversations: { c1: convo() }
    })
    useAppStore.getState().send('c1', 'hello')
    expect(run.start).toHaveBeenCalledWith(
      'c1',
      'hello',
      'anthropic/claude-sonnet-5',
      '/tmp/p',
      null
    )
  })

  it('retryRun resends the last user text WITHOUT a command, even if the turn had one', () => {
    useAppStore.setState({
      modelRef: 'anthropic/claude-sonnet-5',
      conversations: {
        c1: convo({
          events: [
            { type: 'user_message', id: 'u1', text: 'run it', command: workflowRef }
          ] as Event[]
        })
      }
    })
    useAppStore.getState().retryRun('c1')
    expect(run.start).toHaveBeenCalledWith('c1', 'run it', 'anthropic/claude-sonnet-5', '/tmp/p')
    expect(run.start).not.toHaveBeenCalledWith(
      'c1',
      'run it',
      'anthropic/claude-sonnet-5',
      '/tmp/p',
      workflowRef
    )
  })

  it('setResumePickerOpen toggles the flag', () => {
    useAppStore.setState({ resumePickerOpen: false })
    useAppStore.getState().setResumePickerOpen(true)
    expect(useAppStore.getState().resumePickerOpen).toBe(true)
    useAppStore.getState().setResumePickerOpen(false)
    expect(useAppStore.getState().resumePickerOpen).toBe(false)
  })
})

describe('resolvePlanReview mirrors graph.ts planProceedModeFlip (phase3)', () => {
  it('Proceed while permissionMode is plan flips the active conversation to accept-edits', async () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      conversations: { c1: convo({ permissionMode: 'plan' }) },
      permissionMode: 'plan'
    })
    const ok = await useAppStore.getState().resolvePlanReview('call-1', true)
    expect(ok).toBe(true)
    expect(artifacts.resolvePlanReview).toHaveBeenCalledWith('call-1', true, undefined)
    expect(useAppStore.getState().conversations.c1.permissionMode).toBe('accept-edits')
    expect(useAppStore.getState().permissionMode).toBe('accept-edits')
  })

  it('Proceed while permissionMode is NOT plan (e.g. auto) leaves the mode untouched', async () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      conversations: { c1: convo({ permissionMode: 'auto' }) },
      permissionMode: 'auto'
    })
    const ok = await useAppStore.getState().resolvePlanReview('call-1', true)
    expect(ok).toBe(true)
    expect(useAppStore.getState().conversations.c1.permissionMode).toBe('auto')
    expect(useAppStore.getState().permissionMode).toBe('auto')
  })

  it('the Review (proceed:false) path never flips the mode, even from plan', async () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      conversations: { c1: convo({ permissionMode: 'plan' }) },
      permissionMode: 'plan'
    })
    const ok = await useAppStore.getState().resolvePlanReview('call-1', false, 'needs work')
    expect(ok).toBe(true)
    expect(artifacts.resolvePlanReview).toHaveBeenCalledWith('call-1', false, 'needs work')
    expect(useAppStore.getState().conversations.c1.permissionMode).toBe('plan')
    expect(useAppStore.getState().permissionMode).toBe('plan')
  })

  it('a stale/needs-substance result never flips the mode', async () => {
    artifacts.resolvePlanReview.mockResolvedValueOnce('stale')
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      conversations: { c1: convo({ permissionMode: 'plan' }) },
      permissionMode: 'plan'
    })
    const ok = await useAppStore.getState().resolvePlanReview('call-1', true)
    expect(ok).toBe(false)
    expect(useAppStore.getState().conversations.c1.permissionMode).toBe('plan')
    expect(useAppStore.getState().permissionMode).toBe('plan')
  })

  it('updates the per-conversation record even if the view has moved on by the time the IPC resolves, but leaves the now-active surface alone', async () => {
    let resolveIpc: (value: PlanReviewResolveResult) => void = () => {}
    artifacts.resolvePlanReview.mockReturnValueOnce(
      new Promise<PlanReviewResolveResult>((resolve) => {
        resolveIpc = resolve
      })
    )
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      conversations: {
        c1: convo({ permissionMode: 'plan' }),
        c2: convo({ id: 'c2', permissionMode: 'auto' })
      },
      permissionMode: 'plan'
    })
    const pending = useAppStore.getState().resolvePlanReview('call-1', true)
    // The user navigates away to a different conversation before the main
    // process answers.
    useAppStore.setState({ view: { kind: 'conversation', id: 'c2' }, permissionMode: 'auto' })
    resolveIpc('resolved')
    await pending
    expect(useAppStore.getState().conversations.c1.permissionMode).toBe('accept-edits')
    // c2's displayed mode must not be clobbered by c1's flip.
    expect(useAppStore.getState().permissionMode).toBe('auto')
  })
})
