// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useAppStore } from '../../state/store'
import { ProjectsIndex } from './ProjectsIndex'

const openProjectPage = vi.fn()
const toggleProjectPinned = vi.fn(() => Promise.resolve())
const openProjectSettings = vi.fn()
const openTerminalView = vi.fn()
const newConversationInProject = vi.fn(() => Promise.resolve())

function convo(over: Partial<{
  projectPath: string | null
  title: string
  updatedAt: number
  modelRef: string | null
}>): Record<string, unknown> {
  return {
    id: 'x',
    projectPath: null,
    projectLabel: 'x',
    title: 'x',
    updatedAt: 0,
    createdAt: 0,
    pinned: false,
    archived: false,
    runState: 'idle',
    environment: 'local',
    worktrees: [],
    modelRef: null,
    ...over
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useAppStore.setState({
    // Explicitly reset `view` every test (mirrors Sidebar.test.tsx's `mount()`
    // convention) so Zustand state from a prior test file can't leak into a
    // selected-highlight assertion here.
    view: { kind: 'projects' },
    folderSettings: [
      { path: '/proj-a', name: null, color: null, icon: null, pinned: false },
      { path: '/proj-b', name: 'Beta', color: '#4c8dff', icon: null, pinned: true }
    ] as never,
    convoOrder: ['a1', 'a2', 'b1'],
    conversations: {
      a1: convo({ projectPath: '/proj-a', title: 'A1', updatedAt: 10 }),
      a2: convo({ projectPath: '/proj-a', title: 'A2', updatedAt: 20 }),
      b1: convo({ projectPath: '/proj-b', title: 'B1', updatedAt: 5 })
    } as never,
    openProjectPage,
    toggleProjectPinned,
    openProjectSettings,
    openTerminalView,
    newConversationInProject
  } as never)
})
afterEach(cleanup)

describe('ProjectsIndex', () => {
  it('renders every project with its conversation count', () => {
    render(<ProjectsIndex />)
    expect(screen.getByText('proj-a')).toBeInTheDocument()
    expect(screen.getByText('2 conversations')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(screen.getByText('1 conversation')).toBeInTheDocument()
  })

  it('clicking a row opens the project page', () => {
    render(<ProjectsIndex />)
    fireEvent.click(screen.getByText('Beta'))
    expect(openProjectPage).toHaveBeenCalledWith('/proj-b')
  })

  it('the pin toggle calls toggleProjectPinned without opening the project page', () => {
    render(<ProjectsIndex />)
    fireEvent.click(screen.getByLabelText('Pin project'))
    expect(toggleProjectPinned).toHaveBeenCalledWith('/proj-a')
    expect(openProjectPage).not.toHaveBeenCalled()
  })

  it('the Open terminal action calls openTerminalView without opening the project page', () => {
    render(<ProjectsIndex />)
    fireEvent.click(screen.getAllByLabelText('Open terminal')[0])
    expect(openTerminalView).toHaveBeenCalledWith('/proj-a')
    expect(openProjectPage).not.toHaveBeenCalled()
  })

  it('the New conversation action calls newConversationInProject without opening the project page', () => {
    render(<ProjectsIndex />)
    fireEvent.click(screen.getAllByLabelText('New conversation')[0])
    expect(newConversationInProject).toHaveBeenCalledWith('/proj-a')
    expect(openProjectPage).not.toHaveBeenCalled()
  })

  it('sorting by name orders projects alphabetically by resolved label', () => {
    render(<ProjectsIndex />)
    fireEvent.click(screen.getByLabelText('Sort projects'))
    fireEvent.click(screen.getByText('Name'))
    const names = [...document.querySelectorAll('.pidx-row .name')].map((el) => el.textContent)
    expect(names).toEqual(['Beta', 'proj-a'])
  })

  it('sorting by conversation count orders projects descending by count', () => {
    render(<ProjectsIndex />)
    fireEvent.click(screen.getByLabelText('Sort projects'))
    fireEvent.click(screen.getByText('Conversation Count'))
    const names = [...document.querySelectorAll('.pidx-row .name')].map((el) => el.textContent)
    expect(names).toEqual(['proj-a', 'Beta'])
  })

  it('shows an empty state when there are no projects', () => {
    useAppStore.setState({
      folderSettings: [] as never,
      convoOrder: [] as never,
      conversations: {} as never
    })
    render(<ProjectsIndex />)
    expect(screen.getByText('No projects yet')).toBeInTheDocument()
  })

  // Plan 008: the row for the project currently open (view: { kind:
  // 'project', path }) must get the same `.selected` treatment the sidebar's
  // Pinned Projects rows and conversation rows already have.
  it('highlights the row matching the current project view and not other rows', () => {
    useAppStore.setState({ view: { kind: 'project', path: '/proj-a' } } as never)
    render(<ProjectsIndex />)
    const aRow = screen.getByText('proj-a').closest('.pidx-row')
    const bRow = screen.getByText('Beta').closest('.pidx-row')
    expect(aRow).not.toBeNull()
    expect(bRow).not.toBeNull()
    expect(aRow!.className).toContain('selected')
    expect(bRow!.className).not.toContain('selected')
  })

  // Plan 009: row actions (Settings/Terminal/New/Pin) must be wrapped in a
  // hover/focus-reveal wrapper (`.pidx-rowact`), matching the Sidebar's
  // `.sb-rowact` and ProjectPage's `.pp-rowact`. This only asserts the
  // wrapper class is present -- opacity-on-hover is a CSS `:hover`/
  // `:focus-within` pseudo-state that jsdom doesn't meaningfully simulate,
  // so the real verification of the fade in/out behavior is a live-smoke
  // check in the running app, not this test.
  it('wraps the row action buttons in the hover-reveal .pidx-rowact wrapper', () => {
    render(<ProjectsIndex />)
    const settingsButton = screen.getAllByLabelText('Project settings')[0]
    expect(settingsButton.closest('.pidx-rowact')).not.toBeNull()
  })

  it('shows a project derived from conversations even with no folderSettings row (root-cause regression)', () => {
    // A project that has never been renamed/colored/iconed/pinned has no
    // `project_settings` row -- this is the common case, not the exception.
    // The page must still list it, deriving the row from the conversations
    // grouping rather than requiring a folderSettings entry to exist.
    useAppStore.setState({
      folderSettings: [] as never,
      convoOrder: ['a1', 'a2', 'b1'],
      conversations: {
        a1: convo({ projectPath: '/proj-a', title: 'A1', updatedAt: 10 }),
        a2: convo({ projectPath: '/proj-a', title: 'A2', updatedAt: 20 }),
        b1: convo({ projectPath: '/proj-b', title: 'B1', updatedAt: 5 })
      } as never
    })
    render(<ProjectsIndex />)
    expect(screen.getByText('proj-a')).toBeInTheDocument()
    expect(screen.getByText('2 conversations')).toBeInTheDocument()
    expect(screen.getByText('proj-b')).toBeInTheDocument()
    expect(screen.getByText('1 conversation')).toBeInTheDocument()
  })
})
