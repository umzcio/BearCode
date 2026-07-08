// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { Convo } from '../../state/store'
import { useAppStore } from '../../state/store'
import { Sidebar } from './Sidebar'

const setPinned = vi.fn()
const setArchived = vi.fn()
const deleteProject = vi.fn(() => Promise.resolve())
const renameProject = vi.fn(() => Promise.resolve())
const newConversationInProject = vi.fn(() => Promise.resolve())

const convo: Convo = {
  id: 'c1',
  projectPath: null,
  projectLabel: 'No folder',
  title: 'Hello there',
  modelRef: null,
  permissionMode: 'ask',
  effort: 'medium',
  thinking: false,
  projectId: 'p1',
  pinned: false,
  archived: false,
  updatedAt: Date.now(),
  createdAt: Date.now(),
  loaded: true,
  events: [],
  runState: 'idle'
}

beforeEach(() => {
  ;(window as unknown as { bearcode: unknown }).bearcode = {}
  vi.stubGlobal(
    'confirm',
    vi.fn(() => true)
  )
  vi.stubGlobal(
    'prompt',
    vi.fn(() => 'Renamed Project')
  )
  useAppStore.setState({
    sidebarCollapsed: false,
    view: { kind: 'home' },
    convoOrder: ['c1'],
    conversations: { c1: convo },
    projects: [
      { id: 'p1', name: 'Proj', color: null, createdAt: Date.now(), updatedAt: Date.now() }
    ],
    settings: { sidebarGroupBy: 'project', sidebarSort: 'updated' } as never,
    toggleSidebar: vi.fn(),
    goHome: vi.fn(),
    openScheduled: vi.fn(),
    openConvo: vi.fn(),
    deleteConvo: vi.fn(),
    openSettings: vi.fn(),
    openSearch: vi.fn(),
    showToast: vi.fn(),
    createProject: vi.fn(() => Promise.resolve()),
    assignConversationProject: vi.fn(),
    setPinned,
    setArchived,
    deleteProject,
    renameProject,
    newConversationInProject
  } as never)
  setPinned.mockClear()
  setArchived.mockClear()
  deleteProject.mockClear()
  renameProject.mockClear()
  newConversationInProject.mockClear()
})
afterEach(cleanup)

describe('Sidebar pin/archive + project actions', () => {
  it('clicking Pin calls setPinned(id, true)', () => {
    render(<Sidebar />)
    fireEvent.click(screen.getByTitle('Pin'))
    expect(setPinned).toHaveBeenCalledWith('c1', true)
  })

  it('clicking Archive calls setArchived(id, true)', () => {
    render(<Sidebar />)
    fireEvent.click(screen.getByTitle('Archive'))
    expect(setArchived).toHaveBeenCalledWith('c1', true)
  })

  it('project gear Delete calls deleteProject', () => {
    render(<Sidebar />)
    fireEvent.click(screen.getByTitle('Delete project'))
    expect(deleteProject).toHaveBeenCalledWith('p1')
  })

  it('project + calls newConversationInProject', () => {
    render(<Sidebar />)
    fireEvent.click(screen.getByTitle('New conversation in project'))
    expect(newConversationInProject).toHaveBeenCalledWith('p1')
  })
})

describe('Sidebar project color + icon + settings (F9)', () => {
  it('renders a color dot + chosen icon and opens project settings', () => {
    const openProjectSettings = vi.fn()
    useAppStore.setState({
      projects: [
        {
          id: 'p1',
          name: 'Proj',
          color: '#4c8dff',
          icon: 'IconBrain',
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      ] as never,
      openProjectSettings
    } as never)
    const { container } = render(<Sidebar />)
    // Color dot rendered from the project color.
    const dot = container.querySelector('.proj-dot') as HTMLElement
    expect(dot).toBeTruthy()
    expect(dot.style.background).toContain('rgb(76, 141, 255)')
    // Settings button opens the modal for this project.
    fireEvent.click(screen.getByTitle('Project settings'))
    expect(openProjectSettings).toHaveBeenCalledWith('p1')
  })

  it('falls back cleanly when color/icon are unset (no dot)', () => {
    const { container } = render(<Sidebar />)
    expect(container.querySelector('.proj-dot')).toBeNull()
  })
})
