// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useAppStore } from '../../state/store'
import { ProjectPage } from './ProjectPage'

const openProjectSettings = vi.fn()
const openTerminalView = vi.fn()
const newConversationInProject = vi.fn(() => Promise.resolve())
const openConvo = vi.fn()
const setPinned = vi.fn()
const setArchived = vi.fn()
const goHome = vi.fn()
const toggleProjectPinned = vi.fn(() => Promise.resolve())

beforeEach(() => {
  // The mocks above are module-scoped (shared across every test in this
  // file), so their call history must be cleared here -- otherwise a call
  // recorded in an earlier test (e.g. `openConvo` from the "opening a
  // conversation row" test) bleeds into a later test's
  // `.not.toHaveBeenCalled()` assertion.
  vi.clearAllMocks()
  useAppStore.setState({
    conversations: {
      a: {
        id: 'a',
        projectPath: '/proj',
        projectLabel: 'proj',
        title: 'First chat',
        updatedAt: Date.now(),
        createdAt: Date.now(),
        pinned: false,
        archived: false,
        runState: 'idle',
        environment: 'local',
        worktrees: []
      }
    } as never,
    convoOrder: ['a'],
    folderSettings: [],
    view: { kind: 'project', path: '/proj' },
    openProjectSettings,
    openTerminalView,
    newConversationInProject,
    openConvo,
    setPinned,
    setArchived,
    goHome,
    toggleProjectPinned
  } as never)
})
afterEach(cleanup)

describe('ProjectPage', () => {
  it('shows the project name, conversation count, and its conversations', () => {
    render(<ProjectPage path="/proj" />)
    expect(screen.getByText('proj')).toBeTruthy()
    expect(screen.getByText('1 conversation')).toBeTruthy()
    expect(screen.getByText('First chat')).toBeTruthy()
  })

  it('wires the Settings/Terminal/New buttons to their store actions', () => {
    render(<ProjectPage path="/proj" />)
    fireEvent.click(screen.getByText('Settings'))
    expect(openProjectSettings).toHaveBeenCalledWith('/proj')
    fireEvent.click(screen.getByText('Terminal'))
    expect(openTerminalView).toHaveBeenCalledWith('/proj')
    fireEvent.click(screen.getByText('New'))
    expect(newConversationInProject).toHaveBeenCalledWith('/proj')
  })

  it('opening a conversation row calls openConvo', () => {
    render(<ProjectPage path="/proj" />)
    fireEvent.click(screen.getByText('First chat'))
    expect(openConvo).toHaveBeenCalledWith('a')
  })

  // Regression test for the dead "Worktree" Subtitles option (plan 007):
  // ProjectPage.tsx now reads `settings.sidebarSubtitle` and renders the
  // first worktree's branch as a subtitle span, gated on the convo actually
  // being in worktree mode.
  it('renders the worktree branch as a subtitle when sidebarSubtitle is "worktree"', () => {
    useAppStore.setState({
      settings: { sidebarSubtitle: 'worktree' } as never,
      conversations: {
        a: {
          id: 'a',
          projectPath: '/proj',
          projectLabel: 'proj',
          title: 'First chat',
          updatedAt: Date.now(),
          createdAt: Date.now(),
          pinned: false,
          archived: false,
          runState: 'idle',
          environment: 'worktree',
          worktrees: [
            { repoPath: '/proj', worktreePath: '/proj-wt', branch: 'feature-x', baseBranch: 'main' }
          ]
        }
      } as never
    })
    render(<ProjectPage path="/proj" />)
    expect(screen.getByText('feature-x')).toBeTruthy()
  })

  it('does not render a worktree subtitle when sidebarSubtitle is "none" (default)', () => {
    useAppStore.setState({
      // Explicitly reset (rather than relying on beforeEach, which doesn't
      // touch `settings`) so this assertion holds regardless of test order --
      // a prior test in this file may have left `settings.sidebarSubtitle`
      // set to 'worktree'.
      settings: undefined as never,
      conversations: {
        a: {
          id: 'a',
          projectPath: '/proj',
          projectLabel: 'proj',
          title: 'First chat',
          updatedAt: Date.now(),
          createdAt: Date.now(),
          pinned: false,
          archived: false,
          runState: 'idle',
          environment: 'worktree',
          worktrees: [
            { repoPath: '/proj', worktreePath: '/proj-wt', branch: 'feature-x', baseBranch: 'main' }
          ]
        }
      } as never
    })
    render(<ProjectPage path="/proj" />)
    expect(screen.queryByText('feature-x')).not.toBeInTheDocument()
  })

  // Guards against a regression that drops the `environment === 'worktree'`
  // half of the render guard: if only `sidebarSubtitle === 'worktree'` were
  // checked, every conversation (including plain local ones) would grow a
  // subtitle the moment the Display Option was turned on -- even ones with
  // no worktree at all.
  it('does not render a worktree subtitle for a local (non-worktree) conversation, even when sidebarSubtitle is "worktree"', () => {
    useAppStore.setState({
      settings: { sidebarSubtitle: 'worktree' } as never,
      conversations: {
        a: {
          id: 'a',
          projectPath: '/proj',
          projectLabel: 'proj',
          title: 'First chat',
          updatedAt: Date.now(),
          createdAt: Date.now(),
          pinned: false,
          archived: false,
          runState: 'idle',
          environment: 'local',
          // A `worktrees` entry is present anyway -- if the render guard
          // ever dropped its `environment === 'worktree'` check, this would
          // be enough data for the subtitle to render regardless.
          worktrees: [
            { repoPath: '/proj', worktreePath: '/proj-wt', branch: 'feature-x', baseBranch: 'main' }
          ]
        }
      } as never
    })
    render(<ProjectPage path="/proj" />)
    expect(screen.queryByText('feature-x')).not.toBeInTheDocument()
  })

  it('Pin and Archive buttons call their store actions without opening the conversation', () => {
    render(<ProjectPage path="/proj" />)
    fireEvent.click(screen.getByLabelText('Pin'))
    expect(setPinned).toHaveBeenCalledWith('a', true)
    fireEvent.click(screen.getByLabelText('Archive'))
    expect(setArchived).toHaveBeenCalledWith('a', true)
    expect(openConvo).not.toHaveBeenCalled()
  })

  it('the pin toggle reflects folderSettings and calls toggleProjectPinned', () => {
    useAppStore.setState({ folderSettings: [{ path: '/proj', pinned: false }] as never })
    const { unmount } = render(<ProjectPage path="/proj" />)
    const pinBtn = screen.getByLabelText('Pin project')
    fireEvent.click(pinBtn)
    expect(toggleProjectPinned).toHaveBeenCalledWith('/proj')
    unmount()

    useAppStore.setState({ folderSettings: [{ path: '/proj', pinned: true }] as never })
    render(<ProjectPage path="/proj" />)
    expect(screen.getByLabelText('Unpin project')).toBeTruthy()
  })

  it('the "No folder" bucket (null path) has no Settings/Terminal buttons', () => {
    useAppStore.setState({
      conversations: {
        b: {
          id: 'b',
          projectPath: null,
          projectLabel: 'No folder',
          title: 'Loose chat',
          updatedAt: Date.now(),
          createdAt: Date.now(),
          pinned: false,
          archived: false,
          runState: 'idle',
          environment: 'local',
          worktrees: []
        }
      } as never,
      convoOrder: ['b']
    })
    render(<ProjectPage path={null} />)
    expect(screen.queryByText('Settings')).toBeNull()
    expect(screen.queryByText('Terminal')).toBeNull()
    expect(screen.queryByLabelText('Pin project')).toBeNull()
    expect(screen.getByText('New')).toBeTruthy()
    fireEvent.click(screen.getByText('New'))
    expect(goHome).toHaveBeenCalled()
  })
})
