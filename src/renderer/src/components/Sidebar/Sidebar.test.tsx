// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { HERMES_MODEL_REF } from '@shared/types'
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

// Mirrors Sidebar.pinArchive.test.tsx's setup, generalized into a `mount`
// helper (per the task-9 brief) so each test only has to state what it cares
// about: a `conversations` map (id -> partial Convo, merged onto BASE_CONVO)
// and `settings`/`newHermesConversation` overrides. Every store action Sidebar
// or its children (ConvoRowMenu, DisplayOptions) can call is stubbed so a test
// never trips a real side effect.
function mount(opts: {
  conversations?: Record<string, Partial<Convo>>
  settings?: Record<string, unknown>
  newHermesConversation?: ReturnType<typeof vi.fn>
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
    showToast: vi.fn(),
    setPinned: vi.fn(),
    setArchived: vi.fn(),
    renameConversation: vi.fn(),
    deleteConvo: vi.fn(),
    newConversationInProject: vi.fn(() => Promise.resolve()),
    newHermesConversation: opts.newHermesConversation ?? vi.fn(() => Promise.resolve())
  } as never)
  return render(<Sidebar />).container
}

afterEach(cleanup)

describe('Hermes section', () => {
  it('lists only conversations with the Hermes sentinel modelRef, newest first', () => {
    const container = mount({
      conversations: {
        p1: { modelRef: 'anthropic/claude', title: 'Project chat', updatedAt: 1, projectPath: '/x' },
        h1: { modelRef: HERMES_MODEL_REF, title: 'ZRResearch', updatedAt: 200, projectPath: null },
        h2: { modelRef: HERMES_MODEL_REF, title: 'random stuff', updatedAt: 100, projectPath: null }
      },
      settings: { hermesEnabled: true, hermesLabel: 'Hermes', hermesIcon: 'IconChat' }
    })

    expect(screen.getByText('Hermes')).toBeInTheDocument()
    // Project chat is a real project conversation, so it legitimately still
    // renders elsewhere in the sidebar (under Projects) -- just not in the
    // Hermes section itself.
    expect(screen.getByText('Project chat')).toBeInTheDocument()

    // The Hermes section is the first .projects-head/.projects-scroll pair
    // (it renders above Projects); scope to it to assert it holds *only* the
    // two Hermes conversations, newest first.
    const hermesScroll = container.querySelectorAll('.projects-scroll')[0]
    const names = [...hermesScroll.querySelectorAll('.convo .name')].map((el) => el.textContent)
    expect(names).toEqual(['ZRResearch', 'random stuff'])
  })

  it('does not also render Hermes conversations in the "No folder" Projects bucket', () => {
    // Both conversations are project-less; without an exclusion filter the
    // Hermes one would land in Projects' own null-path group too, so it
    // would render (and be clickable) twice.
    mount({
      conversations: {
        h1: { modelRef: HERMES_MODEL_REF, title: 'ZRResearch', updatedAt: 200, projectPath: null },
        p1: { modelRef: 'anthropic/claude', title: 'Plain chat', updatedAt: 50, projectPath: null }
      },
      settings: { hermesEnabled: true, hermesLabel: 'Hermes', hermesIcon: 'IconChat' }
    })

    // The Hermes convo renders exactly once (in the Hermes section).
    expect(screen.getAllByText('ZRResearch')).toHaveLength(1)
    // The non-Hermes, project-less convo still renders in Projects' "No folder" bucket.
    expect(screen.getByText('Plain chat')).toBeInTheDocument()
  })

  it('uses the customized label from settings', () => {
    mount({ conversations: {}, settings: { hermesEnabled: true, hermesLabel: 'Assistant', hermesIcon: 'IconChat' } })
    expect(screen.getByText('Assistant')).toBeInTheDocument()
    expect(screen.queryByText('Hermes')).not.toBeInTheDocument()
  })

  it('is hidden entirely when Hermes is disabled', () => {
    mount({ conversations: {}, settings: { hermesEnabled: false } })
    expect(screen.queryByText('Hermes')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('New Hermes conversation')).not.toBeInTheDocument()
  })

  it('clicking + New calls newHermesConversation', () => {
    const newHermesConversation = vi.fn(() => Promise.resolve())
    mount({
      conversations: {},
      settings: { hermesEnabled: true, hermesLabel: 'Hermes', hermesIcon: 'IconChat' },
      newHermesConversation
    })
    fireEvent.click(screen.getByLabelText('New Hermes conversation'))
    expect(newHermesConversation).toHaveBeenCalledTimes(1)
  })

  it('clicking a Hermes conversation row calls openConvo with its id', () => {
    mount({
      conversations: {
        h1: { modelRef: HERMES_MODEL_REF, title: 'ZRResearch', updatedAt: 200, projectPath: null }
      },
      settings: { hermesEnabled: true, hermesLabel: 'Hermes', hermesIcon: 'IconChat' }
    })
    fireEvent.click(screen.getByText('ZRResearch'))
    expect(useAppStore.getState().openConvo).toHaveBeenCalledWith('h1')
  })
})
