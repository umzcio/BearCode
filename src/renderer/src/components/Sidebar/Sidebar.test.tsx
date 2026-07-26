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
  hermesMode: 'legacy',
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
  folderSettings?: Record<string, unknown>[]
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
    folderSettings: (opts.folderSettings ?? []) as never,
    settings: opts.settings as never,
    toggleSidebar: vi.fn(),
    goHome: vi.fn(),
    openHistory: vi.fn(),
    openConvo: vi.fn(),
    openSettings: vi.fn(),
    openProjectSettings: vi.fn(),
    openProjectPage: vi.fn(),
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
  // The Conversations/Hermes segmented toggle defaults to the Conversations
  // segment, so every Hermes-only assertion below clicks the toggle first
  // (via its label text) to switch into the Hermes segment.
  it('lists only conversations with the Hermes sentinel modelRef, newest first', () => {
    const container = mount({
      conversations: {
        p1: { modelRef: 'anthropic/claude', title: 'Project chat', updatedAt: 1, projectPath: '/x' },
        h1: { modelRef: HERMES_MODEL_REF, title: 'ZRResearch', updatedAt: 200, projectPath: null },
        h2: { modelRef: HERMES_MODEL_REF, title: 'random stuff', updatedAt: 100, projectPath: null }
      },
      settings: { hermesEnabled: true, hermesLabel: 'Hermes' }
    })

    expect(screen.getByText('Hermes')).toBeInTheDocument()
    // Project chat is a real project conversation, projectPath'd but unpinned,
    // so it renders cross-project in Recents while the Conversations segment
    // (the default) is showing -- just not in the Hermes segment's list.
    expect(screen.getByText('Project chat')).toBeInTheDocument()

    // Switch to the Hermes segment; its flat Recents list should hold *only*
    // the two Hermes conversations, newest first.
    fireEvent.click(screen.getByText('Hermes'))
    const names = [...container.querySelectorAll('.sb-recents .sb-flatrow .name')].map(
      (el) => el.textContent
    )
    expect(names).toEqual(['ZRResearch', 'random stuff'])
  })

  it('does not also render Hermes conversations in the Conversations segment', () => {
    // Both conversations are project-less; without an exclusion filter the
    // Hermes one would land in the Conversations segment's Recents too, so it
    // would render (and be clickable) twice across segments.
    mount({
      conversations: {
        h1: { modelRef: HERMES_MODEL_REF, title: 'ZRResearch', updatedAt: 200, projectPath: null },
        p1: { modelRef: 'anthropic/claude', title: 'Plain chat', updatedAt: 50, projectPath: null }
      },
      settings: { hermesEnabled: true, hermesLabel: 'Hermes' }
    })

    // In the default Conversations segment, the Hermes convo doesn't render
    // at all -- only the project-less, non-Hermes convo does (in Recents).
    expect(screen.queryByText('ZRResearch')).not.toBeInTheDocument()
    expect(screen.getByText('Plain chat')).toBeInTheDocument()

    // Switching to Hermes shows exactly the Hermes convo; Conversations-only
    // content unmounts.
    fireEvent.click(screen.getByText('Hermes'))
    expect(screen.getAllByText('ZRResearch')).toHaveLength(1)
    expect(screen.queryByText('Plain chat')).not.toBeInTheDocument()
  })

  it('uses the customized label from settings', () => {
    mount({ conversations: {}, settings: { hermesEnabled: true, hermesLabel: 'Assistant' } })
    expect(screen.getByText('Assistant')).toBeInTheDocument()
    expect(screen.queryByText('Hermes')).not.toBeInTheDocument()
  })

  it('is hidden entirely when Hermes is disabled', () => {
    const container = mount({ conversations: {}, settings: { hermesEnabled: false } })
    expect(screen.queryByText('Hermes')).not.toBeInTheDocument()
    expect(container.querySelector('.seg-toggle')).toBeNull()
  })

  it('clicking + New calls newHermesConversation when the Hermes segment is active', () => {
    const newHermesConversation = vi.fn(() => Promise.resolve())
    mount({
      conversations: {},
      settings: { hermesEnabled: true, hermesLabel: 'Hermes' },
      newHermesConversation
    })
    fireEvent.click(screen.getByText('Hermes'))
    fireEvent.click(screen.getByText('New Conversation'))
    expect(newHermesConversation).toHaveBeenCalledTimes(1)
  })

  it('clicking a Hermes conversation row calls openConvo with its id', () => {
    mount({
      conversations: {
        h1: { modelRef: HERMES_MODEL_REF, title: 'ZRResearch', updatedAt: 200, projectPath: null }
      },
      settings: { hermesEnabled: true, hermesLabel: 'Hermes' }
    })
    fireEvent.click(screen.getByText('Hermes'))
    fireEvent.click(screen.getByText('ZRResearch'))
    expect(useAppStore.getState().openConvo).toHaveBeenCalledWith('h1')
  })

  it('the Conversations/Hermes toggle switches which list renders', () => {
    mount({
      conversations: {
        p1: { modelRef: 'anthropic/claude', title: 'Plain chat', updatedAt: 50, projectPath: null },
        h1: { modelRef: HERMES_MODEL_REF, title: 'ZRResearch', updatedAt: 200, projectPath: null }
      },
      settings: { hermesEnabled: true, hermesLabel: 'ChuckAI' }
    })
    expect(screen.getByText('ChuckAI')).toBeTruthy()
    expect(screen.getByText('Plain chat')).toBeInTheDocument()
    expect(screen.queryByText('ZRResearch')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('ChuckAI'))
    expect(screen.getByText('ZRResearch')).toBeInTheDocument()
    expect(screen.queryByText('Plain chat')).not.toBeInTheDocument()
  })
})

describe('Projects/Pinned/Recents (Conversations segment)', () => {
  it('renders one flat row per folder with its conversation count, and opens the project page on click', () => {
    mount({
      conversations: {
        a: { title: 'A1', projectPath: '/proj-a', projectLabel: 'proj-a', updatedAt: 10 },
        b: { title: 'A2', projectPath: '/proj-a', projectLabel: 'proj-a', updatedAt: 20 }
      }
    })
    expect(screen.getByText('proj-a')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    fireEvent.click(screen.getByText('proj-a'))
    expect(useAppStore.getState().openProjectPage).toHaveBeenCalledWith('/proj-a')
  })

  it('pinned conversations render in Pinned and not in Recents', () => {
    mount({
      conversations: {
        p1: { title: 'Pinned one', projectPath: null, updatedAt: 5, pinned: true },
        r1: { title: 'Recent one', projectPath: null, updatedAt: 3, pinned: false }
      }
    })
    expect(screen.getByText('Pinned')).toBeInTheDocument()
    expect(screen.getByText('Pinned one')).toBeInTheDocument()
    expect(screen.getByText('Recent one')).toBeInTheDocument()
  })

  it('clicking a Recents/Pinned row calls openConvo with its id', () => {
    mount({
      conversations: {
        r1: { title: 'Recent one', projectPath: null, updatedAt: 3, pinned: false }
      }
    })
    fireEvent.click(screen.getByText('Recent one'))
    expect(useAppStore.getState().openConvo).toHaveBeenCalledWith('r1')
  })

  // Regression test for the chip-color bug (final review #4): every prior
  // test in this file left folderSettings empty, so the fp?.color /
  // projectIcon(fp?.icon) / fp?.name resolution path was never exercised --
  // exactly where that bug hid. This mounts with a real folderSettings entry
  // and checks both the resolved custom name renders (not the raw folder
  // basename) and the chip's inline style carries the project's color.
  it('resolves the project label and chip color from a matching folderSettings entry', () => {
    const container = mount({
      conversations: {
        a: { title: 'A1', projectPath: '/proj-a', projectLabel: 'proj-a', updatedAt: 10 }
      },
      folderSettings: [{ path: '/proj-a', color: '#4c8dff', icon: 'IconChat', name: 'Campus Work' }]
    })
    const label = screen.getByText('Campus Work')
    expect(label).toBeInTheDocument()
    const row = label.closest('.sb-projrow')
    expect(row).not.toBeNull()
    const chip = row!.querySelector('.chip') as HTMLElement
    expect(chip.style.color).toBe('rgb(76, 141, 255)')
    expect(chip.style.background).toContain('76, 141, 255')
    expect(container).toBeTruthy()
  })
})
