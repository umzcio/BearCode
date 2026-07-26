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
