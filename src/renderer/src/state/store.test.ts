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
import { useAppStore, shouldFollowNewDiff, refConfigured, type Convo } from './store'
import type { ProviderModels } from '@shared/types'

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
  setPinned: vi.fn(() => Promise.resolve()),
  setArchived: vi.fn(() => Promise.resolve()),
  rename: vi.fn(() => Promise.resolve()),
  get: vi.fn(() => Promise.resolve([])),
  clear: vi.fn(() => Promise.resolve())
}
const run = { start: vi.fn(() => Promise.resolve()), cancel: vi.fn(() => Promise.resolve()) }

const folderProject = (
  path: string,
  patch: Record<string, unknown> = {}
): Record<string, unknown> => ({
  path,
  name: null,
  color: null,
  icon: null,
  defaultModelRef: null,
  defaultEffort: null,
  defaultPermissionMode: null,
  ...patch
})
const projects = {
  list: vi.fn(() => Promise.resolve([])),
  update: vi.fn((path: string, patch: Record<string, unknown>) =>
    Promise.resolve(folderProject(path, patch))
  )
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

const shell = { openFile: vi.fn(() => Promise.resolve()) }

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
  archived: false,
  environment: 'local',
  worktrees: []
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
  environment: 'local',
  effort: 'adaptive',
  thinking: true,
  projectId: null,
  pinned: false,
  archived: false,
  worktrees: [],
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
      projects,
      shell
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

  describe('shouldFollowNewDiff (auto-surface newest diff group)', () => {
    const newDiff = { type: 'file_diff', id: 'ev-d2', diffId: 'd2', files: [] } as unknown as Event
    const base = {
      view: { kind: 'conversation', id: 'c1' } as { kind: string; id?: string },
      auxSelection: { kind: 'diff', diffId: 'd1' } as ReturnType<
        typeof useAppStore.getState
      >['auxSelection'],
      conversations: { c1: { events: [{ id: 'ev-d1' }] } }
    }

    it('follows a new diff when the pane is open on a different diff in the active convo', () => {
      expect(shouldFollowNewDiff(base, 'c1', newDiff)).toBe(true)
    })
    it('does NOT open a closed pane', () => {
      expect(shouldFollowNewDiff({ ...base, auxSelection: null }, 'c1', newDiff)).toBe(false)
    })
    it('does NOT yank off an artifact/plan the user is reading', () => {
      expect(
        shouldFollowNewDiff(
          { ...base, auxSelection: { kind: 'artifact', artifactId: 'a1' } },
          'c1',
          newDiff
        )
      ).toBe(false)
    })
    it('ignores diffs for a non-active conversation', () => {
      expect(
        shouldFollowNewDiff({ ...base, view: { kind: 'conversation', id: 'c2' } }, 'c1', newDiff)
      ).toBe(false)
    })
    it('ignores a re-emit of a diff already in history (not a genuinely new event)', () => {
      const seen = {
        ...base,
        conversations: { c1: { events: [{ id: 'ev-d1' }, { id: 'ev-d2' }] } }
      }
      expect(shouldFollowNewDiff(seen, 'c1', newDiff)).toBe(false)
    })
    it('does not re-follow the diff already selected', () => {
      const same = { type: 'file_diff', id: 'ev-d1b', diffId: 'd1', files: [] } as unknown as Event
      expect(shouldFollowNewDiff(base, 'c1', same)).toBe(false)
    })
    it('ignores non-file_diff events', () => {
      const msg = { type: 'assistant_text', id: 'ev-x', text: 'hi' } as unknown as Event
      expect(shouldFollowNewDiff(base, 'c1', msg)).toBe(false)
    })
  })

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

describe('openFile (E10): Cmd-click a file reference open in the OS default app', () => {
  it('opens the file via the shell IPC, targeting the active conversation', () => {
    useAppStore.setState({ view: { kind: 'conversation', id: 'c1' } })
    useAppStore.getState().openFile('x.docx')
    expect(window.bearcode.shell.openFile).toHaveBeenCalledWith('c1', 'x.docx')
  })
  it('no-ops on Home (no active conversation)', () => {
    useAppStore.setState({ view: { kind: 'home' } })
    useAppStore.getState().openFile('x.docx')
    expect(window.bearcode.shell.openFile).not.toHaveBeenCalled()
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

  it('startFromHome inherits the folder default model/effort/mode over the live composer', async () => {
    useAppStore.setState({
      view: { kind: 'home' },
      // Live composer selection that the folder's opinion should override.
      modelRef: 'anthropic/claude-sonnet-5',
      permissionMode: 'ask',
      effort: 'low',
      workspacePath: '/repo/x',
      providers: [
        {
          id: 'anthropic',
          displayName: 'Anthropic',
          color: '#c96',
          keyConfigured: true,
          reachable: true,
          models: [
            { id: 'claude-sonnet-5', label: 'Sonnet 5' },
            { id: 'claude-opus-4-8', label: 'Opus' }
          ]
        }
      ] as never
    })
    // startFromHome refreshes folder settings (to catch a seeded row) before it
    // resolves; the folder's row comes back from projects.list.
    projects.list.mockResolvedValueOnce([
      folderProject('/repo/x', {
        defaultModelRef: 'anthropic/claude-opus-4-8',
        defaultEffort: 'high',
        defaultPermissionMode: 'plan'
      })
    ] as never)
    useAppStore.getState().startFromHome('do it')
    await vi.waitFor(() => expect(run.start).toHaveBeenCalled())
    expect(conversations.setMode).toHaveBeenCalledWith('c1', 'plan')
    expect(conversations.setEffort).toHaveBeenCalledWith('c1', 'high')
    // run.start uses the folder's model (3rd arg), not the composer's sonnet.
    expect(run.start).toHaveBeenCalledWith(
      'c1',
      'do it',
      'anthropic/claude-opus-4-8',
      '/repo/x',
      null,
      null,
      null
    )
    expect(useAppStore.getState().modelRef).toBe('anthropic/claude-opus-4-8')
  })

  it('startFromHome keeps the live composer choice where the folder is silent', async () => {
    useAppStore.setState({
      view: { kind: 'home' },
      modelRef: 'anthropic/claude-sonnet-5',
      permissionMode: 'auto',
      effort: 'low',
      workspacePath: '/repo/y'
    })
    // Folder row exists but sets no overrides → composer choices stand.
    projects.list.mockResolvedValueOnce([folderProject('/repo/y')] as never)
    useAppStore.getState().startFromHome('hi')
    await vi.waitFor(() => expect(run.start).toHaveBeenCalled())
    expect(conversations.setMode).toHaveBeenCalledWith('c1', 'auto')
    expect(run.start).toHaveBeenCalledWith(
      'c1',
      'hi',
      'anthropic/claude-sonnet-5',
      '/repo/y',
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

describe('folder = project: settings store actions', () => {
  it('refreshProjectSettings populates folderSettings from IPC', async () => {
    ;(window.bearcode.projects.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      folderProject('/repo/x', { color: '#c96' })
    ])
    await useAppStore.getState().refreshProjectSettings()
    expect(useAppStore.getState().folderSettings).toHaveLength(1)
    expect(useAppStore.getState().folderSettings[0].path).toBe('/repo/x')
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
  it('renameConversation updates the convo + persists', () => {
    useAppStore.setState({ conversations: { c1: convo() } })
    useAppStore.getState().renameConversation('c1', 'New')
    expect(useAppStore.getState().conversations.c1.title).toBe('New')
    expect(window.bearcode.conversations.rename).toHaveBeenCalledWith('c1', 'New')
  })
  it('newConversationInProject creates the conversation in the folder and opens it', async () => {
    useAppStore.setState({ conversations: {}, view: { kind: 'home' }, folderSettings: [] })
    await useAppStore.getState().newConversationInProject('/repo/x')
    expect(window.bearcode.conversations.create).toHaveBeenCalledWith('/repo/x')
    expect(useAppStore.getState().view).toEqual({ kind: 'conversation', id: 'c1' })
  })
})

describe('F1 history: openHistory + openConvo focusEventId (jump-to-match)', () => {
  it('openHistory switches to the history view and clears the pane', () => {
    useAppStore.setState({
      view: { kind: 'home' },
      auxSelection: { kind: 'diff', diffId: 'd1' },
      reviewFocusPath: 'src/a.ts'
    })
    useAppStore.getState().openHistory()
    expect(useAppStore.getState().view).toEqual({ kind: 'history' })
    expect(useAppStore.getState().auxSelection).toBeNull()
    expect(useAppStore.getState().reviewFocusPath).toBeNull()
  })

  it('openConvo with a focusEventId opens the conversation and stores it transiently', () => {
    useAppStore.setState({
      view: { kind: 'history' },
      conversations: { c1: convo() },
      focusEventId: null
    })
    useAppStore.getState().openConvo('c1', { focusEventId: 'e9' })
    expect(useAppStore.getState().view).toEqual({ kind: 'conversation', id: 'c1' })
    expect(useAppStore.getState().focusEventId).toBe('e9')
  })

  it('openConvo with no opts leaves focusEventId null (and clears any prior one)', () => {
    useAppStore.setState({
      view: { kind: 'history' },
      conversations: { c1: convo() },
      focusEventId: 'stale'
    })
    useAppStore.getState().openConvo('c1')
    expect(useAppStore.getState().view).toEqual({ kind: 'conversation', id: 'c1' })
    expect(useAppStore.getState().focusEventId).toBeNull()
  })

  it('clearFocusEvent nulls the transient focus and match set', () => {
    useAppStore.setState({ focusEventId: 'e9', focusMatches: ['e9', 'e10'] })
    useAppStore.getState().clearFocusEvent()
    expect(useAppStore.getState().focusEventId).toBeNull()
    expect(useAppStore.getState().focusMatches).toEqual([])
  })

  it('openConvo with focusMatches keeps the full match set for the navigator', () => {
    useAppStore.setState({ view: { kind: 'history' }, conversations: { c1: convo() } })
    useAppStore.getState().openConvo('c1', { focusEventId: 'e2', focusMatches: ['e1', 'e2', 'e3'] })
    expect(useAppStore.getState().focusEventId).toBe('e2')
    expect(useAppStore.getState().focusMatches).toEqual(['e1', 'e2', 'e3'])
  })

  it('openConvo with only focusEventId defaults focusMatches to that single event', () => {
    useAppStore.setState({ view: { kind: 'history' }, conversations: { c1: convo() } })
    useAppStore.getState().openConvo('c1', { focusEventId: 'e2' })
    expect(useAppStore.getState().focusMatches).toEqual(['e2'])
  })

  it('stepFocus walks the match set and clamps at the ends', () => {
    useAppStore.setState({ focusEventId: 'e1', focusMatches: ['e1', 'e2', 'e3'] })
    useAppStore.getState().stepFocus(1)
    expect(useAppStore.getState().focusEventId).toBe('e2')
    useAppStore.getState().stepFocus(1)
    expect(useAppStore.getState().focusEventId).toBe('e3')
    useAppStore.getState().stepFocus(1) // clamped at the last match
    expect(useAppStore.getState().focusEventId).toBe('e3')
    useAppStore.getState().stepFocus(-1)
    expect(useAppStore.getState().focusEventId).toBe('e2')
  })
})

describe('refConfigured (F7 opt-out)', () => {
  const providers: ProviderModels[] = [
    {
      id: 'anthropic',
      displayName: 'Anthropic',
      color: '#d97757',
      requiresKey: true,
      keyConfigured: true,
      reachable: true,
      models: [{ id: 'claude-sonnet-5', label: 'Sonnet 5' }]
    }
  ]

  it('is true when the model is present in the effective list', () => {
    expect(refConfigured(providers, 'anthropic/claude-sonnet-5')).toBe(true)
  })

  it('is false when the model was opted out (no longer in the effective list)', () => {
    // Opus is not in the merged/filtered list → a disabled/hidden model must not
    // read as "configured", so a disabled active/default ref falls through.
    expect(refConfigured(providers, 'anthropic/claude-opus-4-8')).toBe(false)
  })

  it('is false when the provider key is not configured', () => {
    const unconfigured = [{ ...providers[0], keyConfigured: false }]
    expect(refConfigured(unconfigured, 'anthropic/claude-sonnet-5')).toBe(false)
  })

  it('is false for a null ref', () => {
    expect(refConfigured(providers, null)).toBe(false)
  })
})

describe('F9 folder = project: settings + inheritance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({
      folderSettings: [],
      projectSettingsPath: null,
      conversations: {},
      convoOrder: [],
      modelRef: null,
      // The global default model configured, so it can be adopted (refConfigured).
      providers: [
        {
          id: 'anthropic',
          displayName: 'Anthropic',
          color: '#c96',
          keyConfigured: true,
          reachable: true,
          models: [{ id: 'claude-opus-4-8', label: 'Opus' }]
        }
      ] as never,
      settings: {
        defaultModelRef: 'anthropic/claude-opus-4-8',
        defaultEffort: 'adaptive',
        defaultPermissionMode: 'accept-edits'
      } as never
    })
  })

  it('openProjectSettings / closeProjectSettings toggle the modal path', () => {
    useAppStore.getState().openProjectSettings('/repo/x')
    expect(useAppStore.getState().projectSettingsPath).toBe('/repo/x')
    useAppStore.getState().closeProjectSettings()
    expect(useAppStore.getState().projectSettingsPath).toBeNull()
  })

  it('updateProject persists the patch (by path) and refreshes folder settings', async () => {
    await useAppStore.getState().updateProject('/repo/x', { color: '#c96', defaultEffort: 'high' })
    expect(projects.update).toHaveBeenCalledWith('/repo/x', {
      color: '#c96',
      defaultEffort: 'high'
    })
    expect(projects.list).toHaveBeenCalled()
  })

  it('newConversationInProject inherits the folder overrides (effort/mode/model)', async () => {
    useAppStore.setState({
      // gpt-5.1 must be usable for the inherited model to be adopted (refConfigured).
      providers: [
        {
          id: 'openai',
          displayName: 'OpenAI',
          color: '#9ad0b7',
          keyConfigured: true,
          reachable: true,
          models: [{ id: 'gpt-5.1', label: 'GPT-5.1' }]
        }
      ] as never,
      folderSettings: [] as never
    })
    // newConversationInProject refreshes from IPC (to catch a main-side-seeded
    // row) before resolving; the folder's settings come back from projects.list.
    projects.list.mockResolvedValueOnce([
      folderProject('/repo/x', {
        defaultModelRef: 'openai/gpt-5.1',
        defaultEffort: 'high',
        defaultPermissionMode: 'plan'
      })
    ] as never)
    await useAppStore.getState().newConversationInProject('/repo/x')
    expect(conversations.create).toHaveBeenCalledWith('/repo/x')
    expect(conversations.setMode).toHaveBeenCalledWith('c1', 'plan')
    expect(conversations.setEffort).toHaveBeenCalledWith('c1', 'high')
    const s = useAppStore.getState()
    expect(s.modelRef).toBe('openai/gpt-5.1')
    expect(s.permissionMode).toBe('plan')
    expect(s.effort).toBe('high')
  })

  it('does NOT adopt an unusable folder default model (falls back to current selection)', async () => {
    useAppStore.setState({
      modelRef: 'anthropic/claude-opus-4-8',
      providers: [
        {
          id: 'openai',
          displayName: 'OpenAI',
          color: '#9ad0b7',
          keyConfigured: false, // no key → gpt-5.1 not usable
          reachable: true,
          models: [{ id: 'gpt-5.1', label: 'GPT-5.1' }]
        }
      ] as never,
      folderSettings: [] as never
    })
    projects.list.mockResolvedValueOnce([
      folderProject('/repo/x', { defaultModelRef: 'openai/gpt-5.1' })
    ] as never)
    await useAppStore.getState().newConversationInProject('/repo/x')
    expect(useAppStore.getState().modelRef).toBe('anthropic/claude-opus-4-8')
  })

  it('falls back to global defaults when the folder has no stored settings row', async () => {
    useAppStore.setState({ folderSettings: [] })
    await useAppStore.getState().newConversationInProject('/repo/x')
    expect(conversations.setMode).toHaveBeenCalledWith('c1', 'accept-edits')
    expect(conversations.setEffort).toHaveBeenCalledWith('c1', 'adaptive')
    expect(useAppStore.getState().modelRef).toBe('anthropic/claude-opus-4-8')
  })
})
