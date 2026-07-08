import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mirror the ipc.projects.test.ts harness: capture ipcMain.handle registrations
// and invoke them directly, with electron + db + worktree/manager mocked.
const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) },
  app: { getPath: vi.fn(() => '/userdata') },
  BrowserWindow: {},
  dialog: {},
  shell: {}
}))

// vi.mock factories are hoisted above regular const/let; any vi.fn() referenced
// in a factory must be created via vi.hoisted().
const { getConversationMeta, setEnvironment } = vi.hoisted(() => ({
  getConversationMeta: vi.fn(),
  setEnvironment: vi.fn()
}))
vi.mock('./db', () => ({
  getConversationMeta,
  setEnvironment
}))

const { createWorktrees, removeWorktrees, gitAvailable } = vi.hoisted(() => ({
  createWorktrees: vi.fn(),
  removeWorktrees: vi.fn(),
  gitAvailable: vi.fn()
}))
vi.mock('./worktree/manager', () => ({
  createWorktrees,
  removeWorktrees,
  gitAvailable
}))

import { registerIpc } from './ipc'

const WT = [
  { repoPath: '/proj', worktreePath: '/wt/proj', branch: 'bearcode/x', baseBranch: 'main' }
]

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  registerIpc()
})

describe('worktree IPC', () => {
  it('set-environment(worktree) on a git project provisions then persists', async () => {
    gitAvailable.mockResolvedValue(true)
    createWorktrees.mockResolvedValue(WT)
    getConversationMeta.mockReturnValue({
      id: 'c1',
      projectPath: '/proj',
      title: 'My Task',
      environment: 'local',
      worktrees: []
    })
    await handlers.get('bearcode:conversations:set-environment')!({}, 'c1', 'worktree')
    expect(createWorktrees).toHaveBeenCalledWith('/userdata', 'c1', '/proj', 'My Task')
    expect(setEnvironment).toHaveBeenCalledWith('c1', 'worktree', WT)
  })

  it('set-environment(local) stores (local, []) and never provisions', async () => {
    getConversationMeta.mockReturnValue({
      id: 'c1',
      projectPath: '/proj',
      title: 't',
      environment: 'local',
      worktrees: []
    })
    await handlers.get('bearcode:conversations:set-environment')!({}, 'c1', 'local')
    expect(setEnvironment).toHaveBeenCalledWith('c1', 'local', [])
    expect(createWorktrees).not.toHaveBeenCalled()
  })

  it('set-environment(worktree) rejects when git is unavailable and never touches the DB', async () => {
    gitAvailable.mockResolvedValue(false)
    getConversationMeta.mockReturnValue({
      id: 'c1',
      projectPath: '/proj',
      title: 't',
      environment: 'local',
      worktrees: []
    })
    await expect(
      handlers.get('bearcode:conversations:set-environment')!({}, 'c1', 'worktree')
    ).rejects.toThrow(/git/i)
    expect(createWorktrees).not.toHaveBeenCalled()
    expect(setEnvironment).not.toHaveBeenCalled()
  })

  it('set-environment rejects an invalid environment value', async () => {
    await expect(
      handlers.get('bearcode:conversations:set-environment')!({}, 'c1', 'bogus')
    ).rejects.toThrow(/environment/i)
  })

  it('discard removes worktrees and resets the conversation to local', async () => {
    getConversationMeta.mockReturnValue({
      id: 'c1',
      projectPath: '/proj',
      environment: 'worktree',
      worktrees: WT
    })
    await handlers.get('bearcode:worktree:discard')!({}, 'c1')
    expect(removeWorktrees).toHaveBeenCalledWith(WT)
    expect(setEnvironment).toHaveBeenCalledWith('c1', 'local', [])
  })
})
