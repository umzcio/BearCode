// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { Convo } from '../../state/store'
import { useAppStore } from '../../state/store'
import { Sidebar } from './Sidebar'

const setPinned = vi.fn()
const setArchived = vi.fn()
const newConversationInProject = vi.fn(() => Promise.resolve())

const FOLDER = '/Users/zach/Proj'

const convo: Convo = {
  id: 'c1',
  projectPath: FOLDER,
  projectLabel: 'Proj',
  title: 'Hello there',
  modelRef: null,
  permissionMode: 'ask',
  effort: 'medium',
  thinking: false,
  projectId: null,
  pinned: false,
  archived: false,
  updatedAt: Date.now(),
  createdAt: Date.now(),
  loaded: true,
  events: [],
  runState: 'idle',
  environment: 'local'
}

beforeEach(() => {
  ;(window as unknown as { bearcode: unknown }).bearcode = {}
  useAppStore.setState({
    sidebarCollapsed: false,
    view: { kind: 'home' },
    convoOrder: ['c1'],
    conversations: { c1: convo },
    folderSettings: [],
    settings: { sidebarGroupBy: 'project', sidebarSort: 'updated' } as never,
    toggleSidebar: vi.fn(),
    goHome: vi.fn(),
    openConvo: vi.fn(),
    deleteConvo: vi.fn(),
    openSettings: vi.fn(),
    showToast: vi.fn(),
    setPinned,
    setArchived,
    newConversationInProject
  } as never)
  setPinned.mockClear()
  setArchived.mockClear()
  newConversationInProject.mockClear()
})
afterEach(cleanup)

describe('Sidebar pin/archive + folder actions', () => {
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

  it('folder + calls newConversationInProject with the path', () => {
    render(<Sidebar />)
    fireEvent.click(screen.getByTitle('New conversation in this folder'))
    expect(newConversationInProject).toHaveBeenCalledWith(FOLDER)
  })

  it('no gear shows for the "No folder" group', () => {
    useAppStore.setState({
      conversations: { c1: { ...convo, projectPath: null, projectLabel: 'No folder' } }
    } as never)
    render(<Sidebar />)
    expect(screen.queryByTitle('Project settings')).toBeNull()
  })
})

describe('Sidebar folder color + icon + settings (folder = project)', () => {
  it('renders a color dot + chosen icon and opens project settings by path', () => {
    const openProjectSettings = vi.fn()
    useAppStore.setState({
      folderSettings: [
        {
          path: FOLDER,
          name: null,
          color: '#4c8dff',
          icon: 'IconBrain',
          defaultModelRef: null,
          defaultEffort: null,
          defaultPermissionMode: null
        }
      ] as never,
      openProjectSettings
    } as never)
    const { container } = render(<Sidebar />)
    const dot = container.querySelector('.proj-dot') as HTMLElement
    expect(dot).toBeTruthy()
    expect(dot.style.background).toContain('rgb(76, 141, 255)')
    fireEvent.click(screen.getByTitle('Project settings'))
    expect(openProjectSettings).toHaveBeenCalledWith(FOLDER)
  })

  it('uses a custom name override for the group label', () => {
    useAppStore.setState({
      folderSettings: [
        {
          path: FOLDER,
          name: 'Campus Work',
          color: null,
          icon: null,
          defaultModelRef: null,
          defaultEffort: null,
          defaultPermissionMode: null
        }
      ] as never
    } as never)
    render(<Sidebar />)
    expect(screen.getByText('Campus Work')).toBeTruthy()
  })

  it('falls back cleanly when color/icon are unset (no dot)', () => {
    const { container } = render(<Sidebar />)
    expect(container.querySelector('.proj-dot')).toBeNull()
  })
})
