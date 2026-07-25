// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { Convo } from '../../state/store'
import { useAppStore } from '../../state/store'
import { Sidebar } from './Sidebar'

const BASE_CONVO: Convo = {
  id: 'base',
  projectPath: null,
  projectLabel: 'No folder',
  title: 'Untitled',
  modelRef: null,
  permissionMode: 'ask',
  effort: 'medium',
  thinking: false,
  webSearch: false,
  ursaMode: 'code',
  projectId: null,
  pinned: false,
  archived: false,
  updatedAt: 0,
  createdAt: 0,
  loaded: true,
  events: [],
  runState: 'idle',
  environment: 'local',
  worktrees: []
}

function mount(opts: {
  conversations?: Record<string, Partial<Convo>>
  settings?: Record<string, unknown>
}): HTMLElement {
  const conversations: Record<string, Convo> = {}
  for (const [id, partial] of Object.entries(opts.conversations ?? {})) {
    conversations[id] = { ...BASE_CONVO, ...partial, id }
  }
  ;(window as unknown as { bearcode: unknown }).bearcode = {}
  useAppStore.setState({
    sidebarCollapsed: false,
    view: { kind: 'home' },
    convoOrder: Object.keys(conversations),
    conversations,
    folderSettings: [],
    settings: opts.settings as never,
    toggleSidebar: vi.fn(),
    goHome: vi.fn(),
    openHistory: vi.fn(),
    openConvo: vi.fn(),
    openSettings: vi.fn(),
    openProjectSettings: vi.fn(),
    openTerminalView: vi.fn(),
    showToast: vi.fn(),
    setPinned: vi.fn(),
    setArchived: vi.fn(),
    renameConversation: vi.fn(),
    deleteConvo: vi.fn(),
    newConversationInProject: vi.fn(() => Promise.resolve()),
    newHermesConversation: vi.fn(() => Promise.resolve())
  } as never)
  return render(<Sidebar />).container
}

afterEach(cleanup)

describe('Sidebar terminal entry point', () => {
  it('clicking the terminal row-act button opens the terminal view for that folder', () => {
    mount({
      conversations: {
        c1: {
          id: 'c1',
          title: 'Convo',
          projectPath: '/proj/a',
          projectLabel: 'a',
          events: [],
          runState: 'done'
        }
      }
    })
    fireEvent.click(screen.getByLabelText('Open terminal'))
    expect(useAppStore.getState().openTerminalView).toHaveBeenCalledWith('/proj/a')
  })
})
