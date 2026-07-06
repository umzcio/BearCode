import { describe, it, expect, vi, beforeEach } from 'vitest'
import type {
  BearcodeApi,
  CommandEntry,
  ConversationMeta,
  Event,
  MentionRef,
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
  setEffort: vi.fn(() => Promise.resolve()),
  setThinking: vi.fn(() => Promise.resolve()),
  setProject: vi.fn(() => Promise.resolve()),
  setPinned: vi.fn(() => Promise.resolve()),
  setArchived: vi.fn(() => Promise.resolve()),
  get: vi.fn(() => Promise.resolve([])),
  clear: vi.fn(() => Promise.resolve())
}
const run = { start: vi.fn(() => Promise.resolve()), cancel: vi.fn(() => Promise.resolve()) }

const projects = {
  list: vi.fn(() => Promise.resolve([])),
  create: vi.fn(() => Promise.resolve({ id: 'p1', name: 'A', color: null, createdAt: 1, updatedAt: 1 })),
  rename: vi.fn(() => Promise.resolve()),
  delete: vi.fn(() => Promise.resolve())
}

const attachments = {
  pick: vi.fn(() => Promise.resolve({ picked: [], errors: [] })),
  read: vi.fn(() => Promise.resolve(''))
}

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

const mentions = {
  files: vi.fn((_p: string | null, _q: string) => Promise.resolve(['src/a.ts', 'src/b.ts'])),
  rules: vi.fn((_p: string | null) => Promise.resolve([{ name: 'style', firstLine: 'Use tabs.' }]))
}

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
  activeRules: [],
  effort: 'adaptive',
  thinking: true,
  projectId: null,
  pinned: false,
  archived: false
}

const convo = (over: Partial<Convo> = {}): Convo => ({
  id: 'c1',
  projectPath: '/tmp/p',
  projectLabel: 'p',
  title: 'T',
  modelRef: 'anthropic/claude-sonnet-5',
  permissionMode: 'accept-edits',
  updatedAt: 1,
  createdAt: 0,
  loaded: true,
  events: [],
  runState: 'idle',
  effort: 'adaptive',
  thinking: true,
  projectId: null,
  pinned: false,
  archived: false,
  ...over
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', {
    bearcode: {
      permissions,
      conversations,
      run,
      commands,
      artifacts,
      mentions,
      attachments,
      projects
    } as unknown as BearcodeApi
  })
  useAppStore.setState({
    permissionRules: null,
    commands: [],
    resumePickerOpen: false,
    fileSuggestions: [],
    manualRules: [],
    draftConvoId: null
  })
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
      workflowRef,
      null,
      null
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
    expect(run.start).toHaveBeenCalledWith(
      'c1',
      'hello',
      'anthropic/claude-sonnet-5',
      null,
      null,
      null,
      null
    )
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
      workflowRef,
      null,
      null
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
      null,
      null,
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

describe('D4 Media on Home: draft conversation id (fixes greyed-out Media before the first send)', () => {
  it('pickAttachments on Home mints a draft id (once) and picks under it', async () => {
    useAppStore.setState({ view: { kind: 'home' }, draftConvoId: null })
    const first = await useAppStore.getState().pickAttachments(0)
    expect(first).toEqual({ picked: [], errors: [] })
    const mintedId = useAppStore.getState().draftConvoId
    expect(mintedId).toBeTruthy()
    expect(attachments.pick).toHaveBeenCalledWith(mintedId, 0)

    // A second pick on the still-unsent Home composer reuses the SAME id
    // rather than minting a new one each time.
    await useAppStore.getState().pickAttachments(1)
    expect(useAppStore.getState().draftConvoId).toBe(mintedId)
    expect(attachments.pick).toHaveBeenLastCalledWith(mintedId, 1)
  })

  it('pickAttachments in an open conversation uses its real id, not a draft', async () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      conversations: { c1: convo() },
      draftConvoId: null
    })
    await useAppStore.getState().pickAttachments(0)
    expect(attachments.pick).toHaveBeenCalledWith('c1', 0)
    expect(useAppStore.getState().draftConvoId).toBeNull()
  })

  it('startFromHome passes the draft id to conversations.create and clears it', async () => {
    useAppStore.setState({
      view: { kind: 'home' },
      modelRef: 'anthropic/claude-sonnet-5',
      workspacePath: null
    })
    const draftId = useAppStore.getState().ensureDraftConvoId()
    useAppStore.getState().startFromHome('hello')
    await vi.waitFor(() => expect(run.start).toHaveBeenCalled())
    expect(conversations.create).toHaveBeenCalledWith(null, draftId)
    expect(useAppStore.getState().draftConvoId).toBeNull()
  })

  it('startFromHome with no prior draft id creates without a supplied id', async () => {
    useAppStore.setState({
      view: { kind: 'home' },
      modelRef: 'anthropic/claude-sonnet-5',
      workspacePath: null,
      draftConvoId: null
    })
    useAppStore.getState().startFromHome('hello')
    await vi.waitFor(() => expect(run.start).toHaveBeenCalled())
    expect(conversations.create).toHaveBeenCalledWith(null, undefined)
  })

  it('goHome clears any pending draft id', () => {
    useAppStore.setState({ draftConvoId: 'some-draft-id' })
    useAppStore.getState().goHome()
    expect(useAppStore.getState().draftConvoId).toBeNull()
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

describe('D3 mention read-models + send-path threading', () => {
  it('suggestFiles fetches from IPC using the active project and stores results', async () => {
    useAppStore.setState({ view: { kind: 'home' }, workspacePath: '/proj' })
    useAppStore.getState().suggestFiles('a')
    await Promise.resolve()
    await Promise.resolve()
    expect(mentions.files).toHaveBeenCalledWith('/proj', 'a')
    expect(useAppStore.getState().fileSuggestions).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('refreshManualRules populates manualRules from IPC', async () => {
    useAppStore.setState({ view: { kind: 'home' }, workspacePath: '/proj' })
    useAppStore.getState().refreshManualRules()
    await Promise.resolve()
    await Promise.resolve()
    expect(mentions.rules).toHaveBeenCalledWith('/proj')
    expect(useAppStore.getState().manualRules).toEqual([{ name: 'style', firstLine: 'Use tabs.' }])
  })

  it('send forwards mentions as the 6th run.start argument', () => {
    const convoRef = convo({ id: 'c1', projectPath: '/proj' })
    useAppStore.setState({ conversations: { c1: convoRef }, modelRef: 'anthropic/claude-sonnet-5' })
    const refs: MentionRef[] = [{ kind: 'file', name: 'src/a.ts', path: 'src/a.ts' }]
    useAppStore.getState().send('c1', 'hi', null, refs)
    expect(run.start).toHaveBeenCalledWith(
      'c1',
      'hi',
      'anthropic/claude-sonnet-5',
      '/proj',
      null,
      refs,
      null
    )
  })

  it('send forwards attachments as the 7th run.start arg', () => {
    const convoRef = convo({ id: 'c1', projectPath: '/proj' })
    useAppStore.setState({ conversations: { c1: convoRef }, modelRef: 'anthropic/claude-sonnet-5' })
    useAppStore
      .getState()
      .send('c1', 'describe', null, null, [{ id: 'a1', name: 'x.png', mime: 'image/png' }])
    expect(run.start).toHaveBeenCalledWith(
      'c1',
      'describe',
      'anthropic/claude-sonnet-5',
      '/proj',
      null,
      null,
      [{ id: 'a1', name: 'x.png', mime: 'image/png' }]
    )
  })
})

describe('effort/thinking store actions', () => {
  it('setEffort in a conversation updates state + persists over IPC', async () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      conversations: { c1: convo() }
    })
    useAppStore.getState().setEffort('high')
    expect(useAppStore.getState().effort).toBe('high')
    expect(useAppStore.getState().conversations.c1.effort).toBe('high')
    expect(window.bearcode.conversations.setEffort).toHaveBeenCalledWith('c1', 'high')
  })
  it('setEffort on Home updates state only (no IPC)', () => {
    useAppStore.setState({ view: { kind: 'home' } })
    useAppStore.getState().setEffort('max')
    expect(useAppStore.getState().effort).toBe('max')
    expect(window.bearcode.conversations.setEffort).not.toHaveBeenCalled()
  })
  it('setThinking persists a boolean', () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      conversations: { c1: convo() }
    })
    useAppStore.getState().setThinking(false)
    expect(useAppStore.getState().thinking).toBe(false)
    expect(window.bearcode.conversations.setThinking).toHaveBeenCalledWith('c1', false)
  })
  it('opening a conversation hydrates effort/thinking from it', () => {
    useAppStore.setState({
      conversations: { c1: convo({ effort: 'low', thinking: false }) },
      view: { kind: 'home' }
    })
    useAppStore.getState().openConvo('c1')
    expect(useAppStore.getState().effort).toBe('low')
    expect(useAppStore.getState().thinking).toBe(false)
  })
})

describe('projects store actions', () => {
  it('refreshProjects populates from IPC', async () => {
    ;(window.bearcode.projects.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'p1', name: 'A', color: null, createdAt: 1, updatedAt: 1 }
    ])
    await useAppStore.getState().refreshProjects()
    expect(useAppStore.getState().projects).toHaveLength(1)
  })
  it('createProject persists + refreshes', async () => {
    await useAppStore.getState().createProject('Campus')
    expect(window.bearcode.projects.create).toHaveBeenCalledWith('Campus')
  })
  it('assignConversationProject updates the convo + persists', async () => {
    useAppStore.setState({ conversations: { c1: convo() } })
    await useAppStore.getState().assignConversationProject('c1', 'p1')
    expect(useAppStore.getState().conversations.c1.projectId).toBe('p1')
    expect(window.bearcode.conversations.setProject).toHaveBeenCalledWith('c1', 'p1')
  })
  it('deleteProject unassigns local convos', async () => {
    useAppStore.setState({
      projects: [{ id: 'p1', name: 'A', color: null, createdAt: 1, updatedAt: 1 }],
      conversations: { c1: convo({ projectId: 'p1' }) }
    })
    await useAppStore.getState().deleteProject('p1')
    expect(useAppStore.getState().conversations.c1.projectId).toBe(null)
    expect(window.bearcode.projects.delete).toHaveBeenCalledWith('p1')
  })
})

describe('pin/archive + newConversationInProject store actions', () => {
  it('setPinned updates the convo + persists', () => {
    useAppStore.setState({ conversations: { c1: convo() } })
    useAppStore.getState().setPinned('c1', true)
    expect(useAppStore.getState().conversations.c1.pinned).toBe(true)
    expect(window.bearcode.conversations.setPinned).toHaveBeenCalledWith('c1', true)
  })
  it('setArchived updates the convo + persists', () => {
    useAppStore.setState({ conversations: { c1: convo() } })
    useAppStore.getState().setArchived('c1', true)
    expect(useAppStore.getState().conversations.c1.archived).toBe(true)
    expect(window.bearcode.conversations.setArchived).toHaveBeenCalledWith('c1', true)
  })
  it('newConversationInProject creates, assigns, and opens the conversation', async () => {
    useAppStore.setState({ conversations: {}, view: { kind: 'home' } })
    await useAppStore.getState().newConversationInProject('p1')
    expect(window.bearcode.conversations.create).toHaveBeenCalledWith(null)
    expect(window.bearcode.conversations.setProject).toHaveBeenCalledWith('c1', 'p1')
    expect(useAppStore.getState().conversations.c1.projectId).toBe('p1')
    expect(useAppStore.getState().view).toEqual({ kind: 'conversation', id: 'c1' })
  })
})
