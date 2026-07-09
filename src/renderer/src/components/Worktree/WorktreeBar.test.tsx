// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { BearcodeApi, WorktreeInfo } from '@shared/types'
import { useAppStore } from '../../state/store'
import { WorktreeBar } from './WorktreeBar'

function wt(overrides: Partial<WorktreeInfo>): WorktreeInfo {
  return {
    repoPath: '/proj/repo-a',
    worktreePath: '/wt/c1/repo-a',
    branch: 'bearcode/c1',
    baseBranch: 'main',
    ...overrides
  }
}

function seedConvo(
  worktrees: WorktreeInfo[],
  environment: 'local' | 'worktree' = 'worktree'
): void {
  useAppStore.setState({
    view: { kind: 'conversation', id: 'c1' },
    conversations: {
      c1: {
        id: 'c1',
        projectPath: '/proj',
        projectLabel: 'proj',
        title: 'T',
        modelRef: null,
        permissionMode: 'accept-edits',
        effort: 'adaptive',
        thinking: true,
        projectId: null,
        pinned: false,
        archived: false,
        updatedAt: 1,
        createdAt: 1,
        loaded: true,
        events: [],
        runState: 'idle',
        environment,
        worktrees
      }
    },
    convoOrder: ['c1'],
    conflict: null
  } as never)
}

// The zustand store is a singleton: tests that override an action via setState
// would leak the mock into later tests. Capture the pristine actions and
// restore them before each test.
const realMergeWorktree = useAppStore.getState().mergeWorktree
const realDiscardWorktree = useAppStore.getState().discardWorktree

beforeEach(() => {
  useAppStore.setState({
    mergeWorktree: realMergeWorktree,
    discardWorktree: realDiscardWorktree
  } as never)
  ;(window as unknown as { bearcode: BearcodeApi }).bearcode = {
    worktree: {
      merge: vi.fn(async () => ({ status: 'clean' as const, conflictedFiles: [] })),
      discard: vi.fn(async () => {})
    }
  } as unknown as BearcodeApi
})
afterEach(cleanup)

describe('WorktreeBar', () => {
  it('renders a branch label and Merge button per repo for a multi-repo worktree convo', () => {
    seedConvo([
      wt({ repoPath: '/proj/repo-a', branch: 'bearcode/c1' }),
      wt({ repoPath: '/proj/repo-b', branch: 'bearcode/c1-b' })
    ])
    render(<WorktreeBar convoId="c1" />)
    expect(screen.getByText('bearcode/c1')).toBeTruthy()
    expect(screen.getByText('bearcode/c1-b')).toBeTruthy()
    // Multi-repo: the repo basename disambiguates each row.
    expect(screen.getByText('repo-a')).toBeTruthy()
    expect(screen.getByText('repo-b')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /merge to main/i }).length).toBe(2)
  })

  it('renders nothing for a local conversation', () => {
    seedConvo([], 'local')
    const { container } = render(<WorktreeBar convoId="c1" />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when a worktree conversation has no worktrees', () => {
    seedConvo([], 'worktree')
    const { container } = render(<WorktreeBar convoId="c1" />)
    expect(container.firstChild).toBeNull()
  })

  it('clicking Merge calls mergeWorktree with the conversation id and that repo path', () => {
    seedConvo([wt({ repoPath: '/proj/repo-a' })])
    const mergeWorktree = vi.fn()
    useAppStore.setState({ mergeWorktree } as never)
    render(<WorktreeBar convoId="c1" />)
    fireEvent.click(screen.getByRole('button', { name: /merge to main/i }))
    expect(mergeWorktree).toHaveBeenCalledWith('c1', '/proj/repo-a')
  })

  it('clicking Discard after confirming calls discardWorktree', () => {
    seedConvo([wt({})])
    const discardWorktree = vi.fn()
    useAppStore.setState({ discardWorktree } as never)
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<WorktreeBar convoId="c1" />)
    fireEvent.click(screen.getByRole('button', { name: /discard/i }))
    expect(confirmSpy).toHaveBeenCalled()
    expect(discardWorktree).toHaveBeenCalledWith('c1')
    confirmSpy.mockRestore()
  })

  it('cancelling the Discard confirm does not call discardWorktree', () => {
    seedConvo([wt({})])
    const discardWorktree = vi.fn()
    useAppStore.setState({ discardWorktree } as never)
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<WorktreeBar convoId="c1" />)
    fireEvent.click(screen.getByRole('button', { name: /discard/i }))
    expect(discardWorktree).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('disables the Merge button while a merge is in flight (no double-launch)', async () => {
    seedConvo([wt({ repoPath: '/proj/repo-a' })])
    let resolveMerge!: (v: { status: 'clean'; conflictedFiles: string[] }) => void
    ;(window as unknown as { bearcode: BearcodeApi }).bearcode = {
      worktree: {
        merge: vi.fn(
          () =>
            new Promise<{ status: 'clean'; conflictedFiles: string[] }>((res) => {
              resolveMerge = res
            })
        ),
        discard: vi.fn(async () => {})
      }
    } as unknown as BearcodeApi
    render(<WorktreeBar convoId="c1" />)
    const btn = screen.getByRole('button', { name: /merge to main/i }) as HTMLButtonElement
    fireEvent.click(btn)
    await vi.waitFor(() => expect(btn.disabled).toBe(true))
    // A second click while in flight must not launch a second merge.
    fireEvent.click(btn)
    resolveMerge({ status: 'clean', conflictedFiles: [] })
    await vi.waitFor(() => expect(btn.disabled).toBe(false))
    expect(
      (window as unknown as { bearcode: BearcodeApi }).bearcode.worktree.merge
    ).toHaveBeenCalledTimes(1)
  })

  it('a conflicted merge opens the resolver by setting store.conflict (real action)', async () => {
    seedConvo([wt({ repoPath: '/proj/repo-a' })])
    ;(window as unknown as { bearcode: BearcodeApi }).bearcode = {
      worktree: {
        merge: vi.fn(async () => ({ status: 'conflict' as const, conflictedFiles: ['x.ts'] })),
        discard: vi.fn(async () => {})
      }
    } as unknown as BearcodeApi
    render(<WorktreeBar convoId="c1" />)
    fireEvent.click(screen.getByRole('button', { name: /merge to main/i }))
    await vi.waitFor(() => expect(useAppStore.getState().conflict).not.toBeNull())
    expect(useAppStore.getState().conflict).toEqual({
      convId: 'c1',
      repoPath: '/proj/repo-a',
      files: ['x.ts'],
      index: 0
    })
  })
})
