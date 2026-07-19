// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BearcodeApi, ConversationMeta } from '@shared/types'
import { useAppStore } from './store'

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
  worktrees: [],
  ursaMode: 'auto'
}

const conversations = {
  create: vi.fn(() => Promise.resolve(convoMeta)),
  setMode: vi.fn(() => Promise.resolve()),
  setEffort: vi.fn(() => Promise.resolve()),
  setThinking: vi.fn(() => Promise.resolve()),
  setUrsaMode: vi.fn(() => Promise.resolve()),
  setEnvironment: vi.fn(() =>
    Promise.resolve({ ...convoMeta, environment: 'worktree' as const, worktrees: [] })
  )
}
const run = { start: vi.fn(() => Promise.resolve()) }
const projects = { list: vi.fn(() => Promise.resolve([])) }

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', {
    bearcode: { conversations, run, projects } as unknown as BearcodeApi
  })
  useAppStore.setState({
    view: { kind: 'home' },
    modelRef: 'anthropic/claude-sonnet-5',
    workspacePath: null,
    draftConvoId: null,
    composerEnvironment: 'local',
    conversations: {},
    convoOrder: []
  })
})

describe('composer environment', () => {
  it('setComposerEnvironment updates the draft field', () => {
    useAppStore.getState().setComposerEnvironment('worktree')
    expect(useAppStore.getState().composerEnvironment).toBe('worktree')
  })

  it('startFromHome calls setEnvironment when worktree is chosen', async () => {
    useAppStore.getState().setComposerEnvironment('worktree')
    useAppStore.getState().startFromHome('do it')
    await vi.waitFor(() => expect(run.start).toHaveBeenCalled())
    expect(conversations.setEnvironment).toHaveBeenCalledWith('c1', 'worktree')
    expect(useAppStore.getState().conversations['c1']?.environment).toBe('worktree')
  })

  it('does not call setEnvironment when local (default)', async () => {
    useAppStore.getState().startFromHome('do it')
    await vi.waitFor(() => expect(run.start).toHaveBeenCalled())
    expect(conversations.setEnvironment).not.toHaveBeenCalled()
  })

  it('goHome resets composerEnvironment to local', () => {
    useAppStore.getState().setComposerEnvironment('worktree')
    useAppStore.getState().goHome()
    expect(useAppStore.getState().composerEnvironment).toBe('local')
  })
})
