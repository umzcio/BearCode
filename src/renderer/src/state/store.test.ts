import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type {
  BearcodeApi,
  AttachmentRef,
  CommandEntry,
  ConversationMeta,
  Event,
  MentionRef,
  PermissionRulesInfo,
  PlanReviewResolveResult
} from '@shared/types'
import {
  useAppStore,
  shouldFollowNewDiff,
  shouldOpenBrowserPane,
  refConfigured,
  modelDisplay,
  type Convo
} from './store'
import type { ProviderModels } from '@shared/types'
import { HERMES_MODEL_REF, URSA_MODEL_REF, URSUS_MODEL_REF } from '@shared/types'
import { EMPTY_COMPOSER_DRAFT, type ComposerDraft } from '../lib/composerDraft'

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
  createHermes: vi.fn(() =>
    Promise.resolve({ ...convoMeta, id: 'hermes-1', modelRef: HERMES_MODEL_REF })
  ),
  setMode: vi.fn(() => Promise.resolve()),
  setEffort: vi.fn(() => Promise.resolve()),
  setThinking: vi.fn(() => Promise.resolve()),
  setWebSearch: vi.fn(() => Promise.resolve()),
  setUrsaMode: vi.fn(() => Promise.resolve()),
  setPinned: vi.fn(() => Promise.resolve()),
  setArchived: vi.fn(() => Promise.resolve()),
  delete: vi.fn(() => Promise.resolve()),
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
  webSearch: false,
  projectId: null,
  pinned: false,
  archived: false,
  environment: 'local',
  worktrees: [],
  ursaMode: 'code',
  hermesSessionId: null,
  hermesMode: 'legacy'
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
  webSearch: false,
  ursaMode: 'code',
  hermesMode: 'legacy',
  projectId: null,
  pinned: false,
  archived: false,
  worktrees: [],
  ...over
})

const defaultShowToast = useAppStore.getState().showToast

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
    draftConvoId: null,
    pendingHomeConvoId: null,
    acceptedHomeConvoId: null,
    conversationDraftHandoff: null,
    diffReviewComments: {},
    diffReviewSending: {},
    showToast: defaultShowToast
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pane width persistence', () => {
  it('starts a new profile with a 280px sidebar', () => {
    expect(useAppStore.getState().sidebarWidth).toBe(280)
  })

  it('publishes transient widths without storage writes, then persists each released width once', () => {
    const setItem = vi.fn()
    vi.stubGlobal('localStorage', { setItem })

    useAppStore.getState().setSidebarWidth(333.4, { persist: false })
    useAppStore.getState().setAuxPaneWidth(777.6, { persist: false })

    expect(useAppStore.getState().sidebarWidth).toBe(333)
    expect(useAppStore.getState().auxPaneWidth).toBe(778)
    expect(setItem).not.toHaveBeenCalled()

    useAppStore.getState().setSidebarWidth(useAppStore.getState().sidebarWidth)
    useAppStore.getState().setAuxPaneWidth(useAppStore.getState().auxPaneWidth)

    expect(setItem.mock.calls).toEqual([
      ['bearcode.sidebarWidth', '333'],
      ['bearcode.auxPaneWidth', '778']
    ])
  })
})

describe('diff review comment drafts', () => {
  it('keeps comment IDs stable across removal and clears only snapshotted IDs', () => {
    const store = useAppStore.getState()
    store.addDiffReviewComment('diff-1', {
      path: '/repo/a.ts',
      line: 1,
      text: 'first'
    })
    store.addDiffReviewComment('diff-1', {
      path: '/repo/b.ts',
      line: 2,
      text: 'second'
    })
    const [first, second] = useAppStore.getState().diffReviewComments['diff-1']

    store.removeDiffReviewComment('diff-1', first.id)
    store.addDiffReviewComment('diff-1', {
      path: '/repo/c.ts',
      line: 3,
      text: 'late'
    })
    const [stillSecond, late] = useAppStore.getState().diffReviewComments['diff-1']

    expect(stillSecond.id).toBe(second.id)
    expect(late.id).not.toBe(first.id)
    expect(late.id).not.toBe(second.id)

    store.clearDiffReviewComments('diff-1', [second.id])
    expect(useAppStore.getState().diffReviewComments['diff-1']).toEqual([late])
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

  describe('shouldOpenBrowserPane (F4: auto-open the browser pane on a browser_* tool call)', () => {
    const browserCall = {
      type: 'tool_call',
      id: 'ev-b1',
      tool: 'browser_navigate',
      input: {},
      approvalState: 'auto'
    } as unknown as Event
    const base = {
      view: { kind: 'conversation', id: 'c1' } as { kind: string; id?: string },
      auxSelection: null as ReturnType<typeof useAppStore.getState>['auxSelection']
    }

    it('opens the pane when a browser_* tool call arrives for the active conversation', () => {
      expect(shouldOpenBrowserPane(base, 'c1', browserCall)).toBe(true)
    })
    it('opens for every browser_* tool (e.g. browser_read, not just navigate)', () => {
      const read = { ...browserCall, id: 'ev-b2', tool: 'browser_read' } as unknown as Event
      expect(shouldOpenBrowserPane(base, 'c1', read)).toBe(true)
    })
    it('does NOT open for a non-browser tool call', () => {
      const run = { ...browserCall, id: 'ev-r1', tool: 'run_command' } as unknown as Event
      expect(shouldOpenBrowserPane(base, 'c1', run)).toBe(false)
    })
    it('does NOT open for a non-active conversation', () => {
      expect(
        shouldOpenBrowserPane(
          { ...base, view: { kind: 'conversation', id: 'c2' } },
          'c1',
          browserCall
        )
      ).toBe(false)
    })
    it('does NOT re-open when the pane already shows this conversation browser', () => {
      const already = { ...base, auxSelection: { kind: 'browser' as const, conversationId: 'c1' } }
      expect(shouldOpenBrowserPane(already, 'c1', browserCall)).toBe(false)
    })
    it('DOES open when the browser pane is showing a DIFFERENT conversation', () => {
      const other = { ...base, auxSelection: { kind: 'browser' as const, conversationId: 'c2' } }
      expect(shouldOpenBrowserPane(other, 'c1', browserCall)).toBe(true)
    })
    it('ignores non-tool_call events', () => {
      const msg = { type: 'assistant_text', id: 'ev-x', text: 'hi' } as unknown as Event
      expect(shouldOpenBrowserPane(base, 'c1', msg)).toBe(false)
    })

    // Fable B3 finding 2: once a conversation has auto-opened the browser pane
    // (latch), a later browser_* step in the SAME turn must NOT yank the pane
    // back open -- the user may have moved the pane to a diff/artifact to read
    // while the agent works. The latch is the `openedConvos` set.
    it('does NOT re-open once the conversation has already auto-opened (latched), even if the user moved the pane to a diff', () => {
      const onDiff = { ...base, auxSelection: { kind: 'diff' as const, diffId: 'd1' } }
      const latched = new Set(['c1'])
      expect(shouldOpenBrowserPane(onDiff, 'c1', browserCall, latched)).toBe(false)
    })
    it('does NOT re-open when latched even if the pane moved to an artifact', () => {
      const onArtifact = { ...base, auxSelection: { kind: 'artifact' as const, artifactId: 'a1' } }
      const latched = new Set(['c1'])
      expect(shouldOpenBrowserPane(onArtifact, 'c1', browserCall, latched)).toBe(false)
    })
    it('DOES open the first time (not yet latched) even if the pane currently shows a diff', () => {
      const onDiff = { ...base, auxSelection: { kind: 'diff' as const, diffId: 'd1' } }
      expect(shouldOpenBrowserPane(onDiff, 'c1', browserCall, new Set())).toBe(true)
    })
    it('a latch on a DIFFERENT conversation does not suppress this one', () => {
      const latchedOther = new Set(['c2'])
      expect(shouldOpenBrowserPane(base, 'c1', browserCall, latchedOther)).toBe(true)
    })
  })

  it('openArtifactPane selects the artifact, clears focusPath, bumps the open tick', () => {
    useAppStore.setState({ auxSelection: null, auxPaneOpenTick: 0, reviewFocusPath: 'stale' })
    useAppStore.getState().openArtifactPane('a1')
    expect(useAppStore.getState().auxSelection).toEqual({ kind: 'artifact', artifactId: 'a1' })
    expect(useAppStore.getState().auxPaneOpenTick).toBe(1)
    expect(useAppStore.getState().reviewFocusPath).toBeNull()
  })
  it('openAttachmentPane selects the opaque conversation and attachment IDs', () => {
    useAppStore.setState({ auxSelection: null, auxPaneOpenTick: 0, reviewFocusPath: 'stale' })

    useAppStore.getState().openAttachmentPane('conv_123', 'att_123')

    expect(useAppStore.getState().auxSelection).toEqual({
      kind: 'attachment',
      conversationId: 'conv_123',
      attachmentId: 'att_123'
    })
    expect(useAppStore.getState().auxPaneOpenTick).toBe(1)
    expect(useAppStore.getState().reviewFocusPath).toBeNull()
  })
  it('closeReview clears an attachment selection', () => {
    useAppStore.setState({
      auxSelection: {
        kind: 'attachment',
        conversationId: 'conv_123',
        attachmentId: 'att_123'
      }
    })

    useAppStore.getState().closeReview()

    expect(useAppStore.getState().auxSelection).toBeNull()
  })
  it('switching conversations clears an attachment selection', () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      conversations: { c1: convo(), c2: convo({ id: 'c2' }) },
      auxSelection: {
        kind: 'attachment',
        conversationId: 'c1',
        attachmentId: 'att_123'
      }
    })

    useAppStore.getState().openConvo('c2')

    expect(useAppStore.getState().auxSelection).toBeNull()
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
    const accepted = await useAppStore.getState().startFromHome('hi')
    expect(accepted).toBe(true)
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

  it('send returns false without IPC when no model is selected or the conversation is missing', async () => {
    useAppStore.setState({
      modelRef: null,
      conversations: { c1: convo() }
    })

    await expect(useAppStore.getState().send('c1', 'no model')).resolves.toBe(false)
    expect(run.start).not.toHaveBeenCalled()

    useAppStore.setState({
      modelRef: 'anthropic/claude-sonnet-5',
      conversations: {}
    })

    await expect(useAppStore.getState().send('missing', 'no conversation')).resolves.toBe(false)
    expect(run.start).not.toHaveBeenCalled()
  })

  it('send returns true and resets focus only after run.start accepts the dispatch', async () => {
    let acceptRun!: () => void
    run.start.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        acceptRun = resolve
      })
    )
    useAppStore.setState({
      modelRef: 'anthropic/claude-sonnet-5',
      focusEventId: 'event-1',
      focusMatches: ['event-1', 'event-2'],
      conversations: { c1: convo({ modelRef: 'openai/gpt-5' }) }
    })

    const pending = useAppStore.getState().send('c1', 'accepted')

    expect(useAppStore.getState().focusEventId).toBe('event-1')
    expect(useAppStore.getState().focusMatches).toEqual(['event-1', 'event-2'])
    expect(useAppStore.getState().conversations.c1.modelRef).toBe('openai/gpt-5')

    acceptRun()

    await expect(pending).resolves.toBe(true)
    expect(useAppStore.getState().focusEventId).toBeNull()
    expect(useAppStore.getState().focusMatches).toEqual([])
    expect(useAppStore.getState().conversations.c1.modelRef).toBe('anthropic/claude-sonnet-5')
  })

  it('send returns false and reports a rejected run.start without changing accepted-run state', async () => {
    const showToast = vi.fn()
    run.start.mockRejectedValueOnce(new Error('dispatch unavailable'))
    useAppStore.setState({
      modelRef: 'anthropic/claude-sonnet-5',
      focusEventId: 'event-1',
      focusMatches: ['event-1'],
      conversations: { c1: convo({ modelRef: 'openai/gpt-5' }) },
      showToast
    })

    await expect(useAppStore.getState().send('c1', 'rejected')).resolves.toBe(false)

    expect(showToast).toHaveBeenCalledOnce()
    expect(showToast).toHaveBeenCalledWith('dispatch unavailable')
    expect(useAppStore.getState().focusEventId).toBe('event-1')
    expect(useAppStore.getState().focusMatches).toEqual(['event-1'])
    expect(useAppStore.getState().conversations.c1.modelRef).toBe('openai/gpt-5')
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
  it('keeps Home mounted after a rejected first dispatch and reuses the same draft conversation on retry', async () => {
    let rejectFirstRun!: (reason?: unknown) => void
    run.start.mockReturnValueOnce(
      new Promise<void>((_resolve, reject) => {
        rejectFirstRun = reject
      })
    )
    useAppStore.setState({
      view: { kind: 'home' },
      modelRef: 'anthropic/claude-sonnet-5',
      workspacePath: null,
      conversations: {},
      convoOrder: [],
      draftConvoId: 'c1'
    })

    const firstAttempt = useAppStore.getState().startFromHome('keep this draft')
    await vi.waitFor(() => expect(run.start).toHaveBeenCalledOnce())

    expect(useAppStore.getState().view).toEqual({ kind: 'home' })
    expect(useAppStore.getState().draftConvoId).toBe('c1')
    expect(useAppStore.getState().pendingHomeConvoId).toBe('c1')

    rejectFirstRun(new Error('dispatch unavailable'))
    await expect(firstAttempt).resolves.toBe(false)
    expect(useAppStore.getState().view).toEqual({ kind: 'home' })
    expect(useAppStore.getState().draftConvoId).toBe('c1')
    expect(useAppStore.getState().pendingHomeConvoId).toBeNull()

    await expect(useAppStore.getState().startFromHome('keep this draft')).resolves.toBe(true)
    expect(conversations.create).toHaveBeenCalledOnce()
    expect(useAppStore.getState().pendingHomeConvoId).toBe('c1')
    useAppStore.getState().completeHomeStart(EMPTY_COMPOSER_DRAFT)
    expect(useAppStore.getState().view).toEqual({ kind: 'conversation', id: 'c1' })
    expect(useAppStore.getState().draftConvoId).toBeNull()
    expect(useAppStore.getState().pendingHomeConvoId).toBeNull()
  })

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
    useAppStore.getState().completeHomeStart(EMPTY_COMPOSER_DRAFT)
    expect(useAppStore.getState().draftConvoId).toBeNull()
  })

  it('startFromHome with no prior draft id reserves one before create and supplies it', async () => {
    useAppStore.setState({
      view: { kind: 'home' },
      modelRef: 'anthropic/claude-sonnet-5',
      workspacePath: null,
      draftConvoId: null
    })
    const starting = useAppStore.getState().startFromHome('hello')
    const reservedId = useAppStore.getState().draftConvoId
    expect(reservedId).toEqual(expect.any(String))
    await vi.waitFor(() => expect(run.start).toHaveBeenCalled())
    expect(conversations.create).toHaveBeenCalledWith(null, reservedId)
    await expect(starting).resolves.toBe(true)
  })

  it('goHome retains its established cleanup when no Home start is pending', () => {
    useAppStore.setState({
      draftConvoId: 'some-draft-id',
      pendingHomeConvoId: null,
      acceptedHomeConvoId: 'c1',
      conversationDraftHandoff: { conversationId: 'c1', draft: EMPTY_COMPOSER_DRAFT }
    })
    useAppStore.getState().goHome()
    expect(useAppStore.getState().draftConvoId).toBeNull()
    expect(useAppStore.getState().pendingHomeConvoId).toBeNull()
    expect(useAppStore.getState().acceptedHomeConvoId).toBeNull()
    expect(useAppStore.getState().conversationDraftHandoff).toBeNull()
  })
})

describe('Home accepted draft handoff', () => {
  const lateAttachment: AttachmentRef = {
    id: 'attachment-late',
    name: 'late.png',
    mime: 'image/png',
    kind: 'image'
  }
  const lateDraft: ComposerDraft = {
    text: 'late text',
    command: null,
    mentions: [],
    attachments: [{ ref: lateAttachment, previewDataUrl: 'data:image/png;base64,bGF0ZQ==' }]
  }

  it('records acceptance without navigating until Composer transfers ownership', async () => {
    useAppStore.setState({
      view: { kind: 'home' },
      modelRef: 'anthropic/claude-sonnet-5',
      conversations: {},
      draftConvoId: 'c1',
      pendingHomeConvoId: null,
      acceptedHomeConvoId: null,
      conversationDraftHandoff: null
    })

    await expect(useAppStore.getState().startFromHome('submitted')).resolves.toBe(true)

    expect(useAppStore.getState().view).toEqual({ kind: 'home' })
    expect(useAppStore.getState().draftConvoId).toBe('c1')
    expect(useAppStore.getState().pendingHomeConvoId).toBe('c1')
    expect(useAppStore.getState().acceptedHomeConvoId).toBe('c1')
  })

  it.each([
    ['the existing Home view', { kind: 'home' } as const],
    ['an away view', { kind: 'models' } as const]
  ])('makes goHome a genuine state no-op from %s while a Home start is pending', (_label, view) => {
    useAppStore.setState({
      view,
      draftConvoId: 'pending-c1',
      pendingHomeConvoId: 'pending-c1',
      acceptedHomeConvoId: null,
      conversationDraftHandoff: null,
      composerEnvironment: 'worktree'
    })
    const before = useAppStore.getState()

    useAppStore.getState().goHome()

    expect(useAppStore.getState()).toBe(before)
    expect(useAppStore.getState().view).toEqual(view)
    expect(useAppStore.getState().draftConvoId).toBe('pending-c1')
    expect(useAppStore.getState().composerEnvironment).toBe('worktree')
  })

  it('rejects duplicate starts during create and accepted completion without duplicate work', async () => {
    let resolveCreate!: (meta: ConversationMeta) => void
    conversations.create.mockReturnValueOnce(
      new Promise<ConversationMeta>((resolve) => {
        resolveCreate = resolve
      })
    )
    useAppStore.setState({
      view: { kind: 'home' },
      modelRef: 'anthropic/claude-sonnet-5',
      workspacePath: null,
      conversations: {},
      draftConvoId: null,
      pendingHomeConvoId: null,
      acceptedHomeConvoId: null,
      conversationDraftHandoff: null
    })

    const firstStart = useAppStore.getState().startFromHome('first')
    const reservedId = useAppStore.getState().draftConvoId
    expect(reservedId).toEqual(expect.any(String))
    expect(useAppStore.getState().pendingHomeConvoId).toBe(reservedId)

    await expect(useAppStore.getState().startFromHome('duplicate during create')).resolves.toBe(
      false
    )
    expect(conversations.create).toHaveBeenCalledOnce()
    expect(run.start).not.toHaveBeenCalled()

    resolveCreate({ ...convoMeta, id: reservedId! })
    await expect(firstStart).resolves.toBe(true)
    expect(useAppStore.getState().acceptedHomeConvoId).toBe(reservedId)
    expect(useAppStore.getState().pendingHomeConvoId).toBe(reservedId)

    await expect(useAppStore.getState().startFromHome('duplicate before completion')).resolves.toBe(
      false
    )
    expect(conversations.create).toHaveBeenCalledOnce()
    expect(run.start).toHaveBeenCalledOnce()
  })

  it('atomically hands late composer content to the accepted conversation', () => {
    useAppStore.setState({
      view: { kind: 'home' },
      conversations: { c1: convo() },
      draftConvoId: 'c1',
      pendingHomeConvoId: 'c1',
      acceptedHomeConvoId: 'c1',
      conversationDraftHandoff: null
    })

    useAppStore.getState().completeHomeStart(lateDraft)

    expect(useAppStore.getState().view).toEqual({ kind: 'conversation', id: 'c1' })
    expect(useAppStore.getState().draftConvoId).toBeNull()
    expect(useAppStore.getState().pendingHomeConvoId).toBeNull()
    expect(useAppStore.getState().acceptedHomeConvoId).toBeNull()
    expect(useAppStore.getState().conversationDraftHandoff).toEqual({
      conversationId: 'c1',
      draft: lateDraft
    })
    expect(useAppStore.getState().conversationDraftHandoff?.draft.attachments).toEqual([
      { ref: lateAttachment, previewDataUrl: 'data:image/png;base64,bGF0ZQ==' }
    ])
    expect(useAppStore.getState().conversationDraftHandoff?.draft.attachments[0]).toBe(
      lateDraft.attachments[0]
    )
    expect(useAppStore.getState().conversationDraftHandoff?.draft.attachments[0]?.ref).toBe(
      lateAttachment
    )
  })

  it('navigates with no handoff when the remaining draft is empty', () => {
    useAppStore.setState({
      view: { kind: 'home' },
      conversations: { c1: convo() },
      draftConvoId: 'c1',
      pendingHomeConvoId: 'c1',
      acceptedHomeConvoId: 'c1',
      conversationDraftHandoff: null
    })

    useAppStore.getState().completeHomeStart(EMPTY_COMPOSER_DRAFT)

    expect(useAppStore.getState().view).toEqual({ kind: 'conversation', id: 'c1' })
    expect(useAppStore.getState().draftConvoId).toBeNull()
    expect(useAppStore.getState().pendingHomeConvoId).toBeNull()
    expect(useAppStore.getState().acceptedHomeConvoId).toBeNull()
    expect(useAppStore.getState().conversationDraftHandoff).toBeNull()
  })

  it('makes duplicate completion and wrong-conversation consumption no-ops', () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      conversations: { c1: convo() },
      draftConvoId: null,
      acceptedHomeConvoId: null,
      conversationDraftHandoff: { conversationId: 'c1', draft: lateDraft }
    })

    useAppStore.getState().completeHomeStart(EMPTY_COMPOSER_DRAFT)
    useAppStore.getState().consumeConversationDraftHandoff('c2')

    expect(useAppStore.getState().view).toEqual({ kind: 'conversation', id: 'c1' })
    expect(useAppStore.getState().conversationDraftHandoff).toEqual({
      conversationId: 'c1',
      draft: lateDraft
    })
  })

  it('clears a matching handoff exactly once', () => {
    useAppStore.setState({
      conversationDraftHandoff: { conversationId: 'c1', draft: lateDraft }
    })

    useAppStore.getState().consumeConversationDraftHandoff('c1')
    expect(useAppStore.getState().conversationDraftHandoff).toBeNull()

    useAppStore.getState().consumeConversationDraftHandoff('c1')
    expect(useAppStore.getState().conversationDraftHandoff).toBeNull()
  })

  it('retains Home and the draft id when starting is rejected', async () => {
    run.start.mockRejectedValueOnce(new Error('dispatch unavailable'))
    useAppStore.setState({
      view: { kind: 'home' },
      modelRef: 'anthropic/claude-sonnet-5',
      conversations: {},
      draftConvoId: 'c1',
      pendingHomeConvoId: null,
      acceptedHomeConvoId: null,
      conversationDraftHandoff: null
    })

    await expect(useAppStore.getState().startFromHome('submitted')).resolves.toBe(false)

    expect(useAppStore.getState().view).toEqual({ kind: 'home' })
    expect(useAppStore.getState().draftConvoId).toBe('c1')
    expect(useAppStore.getState().pendingHomeConvoId).toBeNull()
    expect(useAppStore.getState().acceptedHomeConvoId).toBeNull()
    expect(useAppStore.getState().conversationDraftHandoff).toBeNull()
  })

  it('clears an unconsumed handoff when its conversation is deleted', async () => {
    useAppStore.setState({
      conversations: { c1: convo() },
      pendingHomeConvoId: 'c1',
      conversationDraftHandoff: { conversationId: 'c1', draft: lateDraft }
    })

    useAppStore.getState().deleteConvo('c1')

    await vi.waitFor(() => expect(useAppStore.getState().conversations.c1).toBeUndefined())
    expect(useAppStore.getState().pendingHomeConvoId).toBeNull()
    expect(useAppStore.getState().conversationDraftHandoff).toBeNull()
  })

  it('does not restore accepted ownership after deletion wins a deferred start race', async () => {
    let resolveRun!: () => void
    run.start.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveRun = resolve
      })
    )
    useAppStore.setState({
      view: { kind: 'home' },
      modelRef: 'anthropic/claude-sonnet-5',
      conversations: {},
      draftConvoId: 'c1',
      pendingHomeConvoId: null,
      acceptedHomeConvoId: null,
      conversationDraftHandoff: null
    })

    const starting = useAppStore.getState().startFromHome('submitted')
    await vi.waitFor(() => expect(run.start).toHaveBeenCalledOnce())

    useAppStore.getState().deleteConvo('c1')
    await vi.waitFor(() => expect(useAppStore.getState().conversations.c1).toBeUndefined())

    resolveRun()
    await expect(starting).resolves.toBe(true)

    expect(useAppStore.getState().acceptedHomeConvoId).toBeNull()
    expect(useAppStore.getState().pendingHomeConvoId).toBeNull()
    expect(useAppStore.getState().conversationDraftHandoff).toBeNull()

    useAppStore.getState().completeHomeStart(lateDraft)
    expect(useAppStore.getState().view).toEqual({ kind: 'home' })
    expect(useAppStore.getState().acceptedHomeConvoId).toBeNull()
    expect(useAppStore.getState().conversationDraftHandoff).toBeNull()
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

  it('opening a Hermes conversation syncs the top-level modelRef to HERMES_MODEL_REF', () => {
    // Regression: refConfigured previously had no HERMES_MODEL_REF exception,
    // so this sync was blocked -- send()/retryRun() (which read the top-level
    // modelRef) would dispatch under whatever concrete model was last active
    // instead of routing to Hermes. Mirrors the Ursa/Ursus case.
    useAppStore.setState({
      conversations: { c1: convo({ modelRef: HERMES_MODEL_REF }) },
      view: { kind: 'home' },
      modelRef: 'anthropic/claude-sonnet-5'
    })
    useAppStore.getState().openConvo('c1')
    expect(useAppStore.getState().modelRef).toBe(HERMES_MODEL_REF)
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

  it('toggleProjectPinned patches folderSettings synchronously so two rapid calls net out correctly', async () => {
    useAppStore.setState({
      folderSettings: [folderProject('/proj', { pinned: false })] as never
    })
    // Hold both IPC round-trips open so we can assert on the optimistic state
    // before either resolves -- this is the rapid-double-click race the fix
    // targets: without the synchronous patch, both calls would read the same
    // stale `pinned: false` snapshot and flip it the same direction.
    let resolveUpdate1: (value: unknown) => void = () => {}
    let resolveUpdate2: (value: unknown) => void = () => {}
    const updateMock = window.bearcode.projects.update as unknown as ReturnType<typeof vi.fn>
    updateMock
      .mockImplementationOnce(() => new Promise((resolve) => (resolveUpdate1 = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveUpdate2 = resolve)))
    ;(window.bearcode.projects.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      folderProject('/proj', { pinned: false })
    ])

    const store = useAppStore.getState()
    const p1 = store.toggleProjectPinned('/proj')
    // Assert synchronously (no await yet): the optimistic patch already flipped
    // pinned to true before the first IPC call has resolved.
    expect(
      useAppStore.getState().folderSettings.find((f) => f.path === '/proj')?.pinned
    ).toBe(true)

    const p2 = store.toggleProjectPinned('/proj')
    // The second call reads the just-patched value (true), so it flips back to
    // false instead of racing on the same stale snapshot.
    expect(
      useAppStore.getState().folderSettings.find((f) => f.path === '/proj')?.pinned
    ).toBe(false)

    resolveUpdate1(folderProject('/proj', { pinned: true }))
    resolveUpdate2(folderProject('/proj', { pinned: false }))
    await Promise.all([p1, p2])

    // Final, reconciled state: toggled twice nets back to the original value.
    expect(
      useAppStore.getState().folderSettings.find((f) => f.path === '/proj')?.pinned
    ).toBe(false)
  })
})

describe('pin/archive + newConversationInProject store actions', () => {
  it('creates Hermes conversations with the explicitly configured native mode', async () => {
    useAppStore.setState({
      conversations: {},
      view: { kind: 'home' },
      settings: { hermesConnectionMode: 'native' } as never
    })

    await useAppStore.getState().newHermesConversation()

    expect(window.bearcode.conversations.createHermes).toHaveBeenCalledWith('native')
  })

  it('newHermesConversation clears an attachment selected in the previous conversation', async () => {
    useAppStore.setState({
      conversations: { previous: convo({ id: 'previous' }) },
      view: { kind: 'conversation', id: 'previous' },
      auxSelection: {
        kind: 'attachment',
        conversationId: 'previous',
        attachmentId: 'att_previous'
      }
    })

    await useAppStore.getState().newHermesConversation()

    expect(useAppStore.getState().view).toEqual({ kind: 'conversation', id: 'hermes-1' })
    expect(useAppStore.getState().auxSelection).toBeNull()
  })

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

  it('newConversationInProject clears an attachment selected in the previous conversation', async () => {
    useAppStore.setState({
      conversations: { previous: convo({ id: 'previous' }) },
      view: { kind: 'conversation', id: 'previous' },
      folderSettings: [],
      auxSelection: {
        kind: 'attachment',
        conversationId: 'previous',
        attachmentId: 'att_previous'
      }
    })

    await useAppStore.getState().newConversationInProject('/repo/x')

    expect(useAppStore.getState().view).toEqual({ kind: 'conversation', id: 'c1' })
    expect(useAppStore.getState().auxSelection).toBeNull()
  })

  it('newConversationInProject shows a toast instead of throwing when conversations.create rejects', async () => {
    useAppStore.setState({ conversations: {}, view: { kind: 'home' }, folderSettings: [], toast: null })
    vi.mocked(window.bearcode.conversations.create).mockRejectedValueOnce(new Error('disk full'))
    await expect(useAppStore.getState().newConversationInProject('/repo/x')).resolves.toBeUndefined()
    expect(useAppStore.getState().toast?.message).toBe('disk full')
    expect(useAppStore.getState().view).toEqual({ kind: 'home' })
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

  it('is always true for the Ursa sentinel, even with no matching provider entry', () => {
    // Regression: the sentinel isn't a real "provider/modelId" ref, so without
    // this special case the composer's "No API key for the selected model"
    // notice showed even when Ursa was fully usable -- ModelPicker already
    // gates its selectability, this must not re-derive a false negative.
    expect(refConfigured(providers, URSA_MODEL_REF)).toBe(true)
    expect(refConfigured([], URSA_MODEL_REF)).toBe(true)
  })

  it('is always true for the Ursus sentinel, even with no matching provider entry', () => {
    // Same rationale as the Ursa sentinel above: the sentinel isn't a real
    // "provider/modelId" ref, so without this special case the composer's
    // "No API key for the selected model" notice showed even when Ursus was
    // fully usable -- ModelPicker already gates its selectability, this must
    // not re-derive a false negative.
    expect(refConfigured(providers, URSUS_MODEL_REF)).toBe(true)
    expect(refConfigured([], URSUS_MODEL_REF)).toBe(true)
  })

  it('is always true for the Hermes sentinel, even with no matching provider entry', () => {
    // Regression: without this exception, openConvo's refConfigured guard never
    // synced the store's top-level modelRef to HERMES_MODEL_REF, so send()/
    // retryRun() (which read the top-level modelRef) dispatched Hermes turns
    // under whatever concrete model was last active instead of routing to
    // Hermes -- see openConvo test below.
    expect(refConfigured(providers, HERMES_MODEL_REF)).toBe(true)
    expect(refConfigured([], HERMES_MODEL_REF)).toBe(true)
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

describe('modelDisplay — Ursa sentinel', () => {
  it('returns "Ursa" instead of falling through to "Choose a model"', () => {
    const result = modelDisplay([], URSA_MODEL_REF)
    expect(result.name).toBe('Ursa')
    // Orange, matching ursa-teddy.svg (was BearCode blue).
    expect(result.color).toBe('#ed5500')
  })
})

describe('modelDisplay — Ursus sentinel', () => {
  it('returns "Ursus" instead of falling through to "Choose a model"', () => {
    const result = modelDisplay([], URSUS_MODEL_REF)
    expect(result.name).toBe('Ursus')
    // Light blue, matching ursus-teddy.svg (was brown, for the retired
    // walking-bear icon).
    expect(result.color).toBe('#6ec3fa')
  })
})

describe('pricing/models store actions', () => {
  beforeEach(() => {
    // Setup pricing mocks for this test suite
    vi.stubGlobal('window', {
      bearcode: {
        pricing: { sync: vi.fn(() => Promise.resolve({})) },
        settings: { get: vi.fn(() => Promise.resolve({})) },
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
  })

  it('syncPricing calls refreshProviders and refreshManageableModels after fetching settings', async () => {
    const pricingSyncResult = { syncedCount: 1, metadataCount: 1, unmatched: [], syncedAt: Date.now() }
    vi.mocked(window.bearcode.pricing.sync).mockResolvedValue(pricingSyncResult)
    vi.mocked(window.bearcode.settings.get).mockResolvedValue({
      modelPricing: { 'anthropic/claude-opus-4-8': { inputCostPer1kTokens: 0.015 } },
      modelMetadata: {},
      favoriteModels: [],
      modelPricingSyncedAt: Date.now()
    } as unknown as Awaited<ReturnType<typeof window.bearcode.settings.get>>)

    // Setup spy/mock functions for the refresh actions. Capture the real
    // implementations first and restore them afterward — useAppStore is a
    // module-level singleton, so replacing these via setState would otherwise
    // leak a permanent no-op refreshProviders/refreshManageableModels into
    // every later describe block in this file.
    const realRefreshProviders = useAppStore.getState().refreshProviders
    const realRefreshManageableModels = useAppStore.getState().refreshManageableModels
    const refreshProviders = vi.fn().mockResolvedValue(undefined)
    const refreshManageableModels = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({ refreshProviders, refreshManageableModels } as never)

    try {
      // Call the real syncPricing action
      const result = await useAppStore.getState().syncPricing()

      // Verify the IPC calls were made
      expect(window.bearcode.pricing.sync).toHaveBeenCalled()
      expect(window.bearcode.settings.get).toHaveBeenCalled()

      // Verify the refresh functions were called by the real action
      expect(refreshProviders).toHaveBeenCalled()
      expect(refreshManageableModels).toHaveBeenCalled()

      // Verify the result is returned
      expect(result).toEqual(pricingSyncResult)
    } finally {
      useAppStore.setState({
        refreshProviders: realRefreshProviders,
        refreshManageableModels: realRefreshManageableModels
      } as never)
    }
  })
})

describe('setModelEnabled — liveOnly models opt-in via enabledLiveModels', () => {
  const modelsList = { list: vi.fn(() => Promise.resolve([])) }
  const modelsManageable = { manageable: vi.fn(() => Promise.resolve([])) }
  const settingsSet = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('window', {
      bearcode: {
        models: { list: modelsList.list, manageable: modelsManageable.manageable },
        settings: { set: settingsSet },
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
    modelsList.list.mockClear()
    modelsManageable.manageable.mockClear()
    settingsSet.mockReset()
  })

  it('writes to enabledLiveModels (not disabledModels) for a liveOnly model', async () => {
    useAppStore.setState({
      settings: { disabledModels: [], enabledLiveModels: [] } as never,
      manageableModels: [
        {
          id: 'anthropic',
          displayName: 'Anthropic',
          color: '#d97757',
          models: [
            {
              id: 'claude-new-model',
              label: 'Claude New Model',
              custom: false,
              enabled: false,
              liveOnly: true
            }
          ]
        }
      ] as never
    })
    settingsSet.mockResolvedValue({
      disabledModels: [],
      enabledLiveModels: ['anthropic/claude-new-model']
    })

    await useAppStore.getState().setModelEnabled('anthropic/claude-new-model', true)

    expect(settingsSet).toHaveBeenCalledWith({
      enabledLiveModels: ['anthropic/claude-new-model'],
      disabledModels: []
    })
    expect(useAppStore.getState().settings?.enabledLiveModels).toEqual([
      'anthropic/claude-new-model'
    ])
    expect(useAppStore.getState().settings?.disabledModels).toEqual([])
    expect(modelsList.list).toHaveBeenCalled()
  })

  it('unchanged: a non-liveOnly model still patches disabledModels, never enabledLiveModels', async () => {
    useAppStore.setState({
      settings: { disabledModels: [], enabledLiveModels: ['anthropic/some-other-live'] } as never,
      manageableModels: [
        {
          id: 'anthropic',
          displayName: 'Anthropic',
          color: '#d97757',
          models: [
            {
              id: 'claude-opus-4-8',
              label: 'Opus',
              custom: false,
              enabled: true,
              liveOnly: false
            }
          ]
        }
      ] as never
    })
    settingsSet.mockResolvedValue({
      disabledModels: ['anthropic/claude-opus-4-8'],
      enabledLiveModels: ['anthropic/some-other-live']
    })

    await useAppStore.getState().setModelEnabled('anthropic/claude-opus-4-8', false)

    expect(settingsSet).toHaveBeenCalledWith({ disabledModels: ['anthropic/claude-opus-4-8'] })
    expect(useAppStore.getState().settings?.disabledModels).toEqual(['anthropic/claude-opus-4-8'])
    expect(useAppStore.getState().settings?.enabledLiveModels).toEqual([
      'anthropic/some-other-live'
    ])
  })

  it('removes a stale disabledModels entry when re-enabling a liveOnly model', async () => {
    useAppStore.setState({
      settings: {
        disabledModels: ['anthropic/claude-new-model'],
        enabledLiveModels: []
      } as never,
      manageableModels: [
        {
          id: 'anthropic',
          displayName: 'Anthropic',
          color: '#d97757',
          models: [
            {
              id: 'claude-new-model',
              label: 'Claude New Model',
              custom: false,
              enabled: false,
              liveOnly: true
            }
          ]
        }
      ] as never
    })
    settingsSet.mockResolvedValue({
      disabledModels: [],
      enabledLiveModels: ['anthropic/claude-new-model']
    })

    await useAppStore.getState().setModelEnabled('anthropic/claude-new-model', true)

    expect(settingsSet).toHaveBeenCalledWith({
      enabledLiveModels: ['anthropic/claude-new-model'],
      disabledModels: []
    })
    expect(useAppStore.getState().settings?.disabledModels).toEqual([])
    expect(useAppStore.getState().settings?.enabledLiveModels).toEqual([
      'anthropic/claude-new-model'
    ])
  })

  it('bails out with no patch when the ref is not found in manageableModels', async () => {
    useAppStore.setState({
      settings: { disabledModels: [], enabledLiveModels: [] } as never,
      manageableModels: [] as never
    })

    await useAppStore.getState().setModelEnabled('anthropic/does-not-exist', true)

    expect(settingsSet).not.toHaveBeenCalled()
  })
})
