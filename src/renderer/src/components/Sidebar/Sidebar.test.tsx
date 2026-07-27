// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
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
  view?: { kind: string; path?: string | null; id?: string }
}): HTMLElement {
  const conversations: Record<string, Convo> = {}
  for (const [id, partial] of Object.entries(opts.conversations ?? {})) {
    conversations[id] = { ...BASE_CONVO, ...partial, id }
  }
  ;(window as unknown as { bearcode: unknown }).bearcode = {}
  useAppStore.setState({
    sidebarCollapsed: false,
    view: opts.view ?? { kind: 'home' },
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
    openTerminalView: vi.fn(),
    openProjectPage: vi.fn(),
    openProjectsIndex: vi.fn(),
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
  it('renders a single "Projects" nav link (not one row per folder) that opens the Projects index', () => {
    mount({
      conversations: {
        a: { title: 'A1', projectPath: '/proj-a', projectLabel: 'proj-a', updatedAt: 10 },
        b: { title: 'A2', projectPath: '/proj-a', projectLabel: 'proj-a', updatedAt: 20 }
      }
    })
    // The old flat per-project list is gone -- no bare "proj-a" row or count
    // renders inline in the sidebar anymore, just the nav link.
    expect(screen.queryByText('proj-a')).not.toBeInTheDocument()
    expect(screen.getByText('Projects')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Projects'))
    expect(useAppStore.getState().openProjectsIndex).toHaveBeenCalledTimes(1)
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

  // Regression test for the dead "Worktree" Subtitles option (plan 007):
  // Sidebar.tsx now reads `settings.sidebarSubtitle` and renders the first
  // worktree's branch as a second line, in both the Pinned and Recents
  // blocks, gated on the convo actually being in worktree mode.
  it('renders the worktree branch as a subtitle when sidebarSubtitle is "worktree"', () => {
    mount({
      conversations: {
        p1: {
          title: 'Pinned convo',
          projectPath: null,
          updatedAt: 5,
          pinned: true,
          environment: 'worktree',
          worktrees: [
            { repoPath: '/r', worktreePath: '/r-wt', branch: 'feature-x', baseBranch: 'main' }
          ]
        },
        r1: {
          title: 'Recent convo',
          projectPath: null,
          updatedAt: 3,
          pinned: false,
          environment: 'worktree',
          worktrees: [
            { repoPath: '/r', worktreePath: '/r-wt', branch: 'feature-x', baseBranch: 'main' }
          ]
        }
      },
      settings: { sidebarSubtitle: 'worktree' }
    })
    expect(screen.getAllByText('feature-x')).toHaveLength(2)
  })

  it('does not render a worktree subtitle when sidebarSubtitle is "none" (default)', () => {
    mount({
      conversations: {
        r1: {
          title: 'Recent convo',
          projectPath: null,
          updatedAt: 3,
          pinned: false,
          environment: 'worktree',
          worktrees: [
            { repoPath: '/r', worktreePath: '/r-wt', branch: 'feature-x', baseBranch: 'main' }
          ]
        }
      }
    })
    expect(screen.queryByText('feature-x')).not.toBeInTheDocument()
  })

  // Guards against a regression that drops the `environment === 'worktree'`
  // half of the render guard: if only `sidebarSubtitle === 'worktree'` were
  // checked, every conversation (including plain local ones, BASE_CONVO's
  // default) would grow a subtitle the moment the Display Option was turned
  // on -- even ones with no worktree at all.
  it('does not render a worktree subtitle for a local (non-worktree) conversation, even when sidebarSubtitle is "worktree"', () => {
    mount({
      conversations: {
        r1: {
          title: 'Recent convo',
          projectPath: null,
          updatedAt: 3,
          pinned: false,
          // environment defaults to 'local' via BASE_CONVO, but a
          // `worktrees` entry is present anyway -- if the render guard ever
          // dropped its `environment === 'worktree'` check, this would be
          // enough data for the subtitle to render regardless.
          worktrees: [
            { repoPath: '/r', worktreePath: '/r-wt', branch: 'feature-x', baseBranch: 'main' }
          ]
        }
      },
      settings: { sidebarSubtitle: 'worktree' }
    })
    expect(screen.queryByText('feature-x')).not.toBeInTheDocument()
  })

  // Regression test for the chip-color bug (final review #4), now exercised
  // through the "Pinned Projects" section instead of the retired flat list:
  // checks both the resolved custom name renders (not the raw folder
  // basename) and the chip's inline style carries the project's color.
  it('resolves the pinned-project label and chip color from a matching folderSettings entry', () => {
    const container = mount({
      conversations: {
        a: { title: 'A1', projectPath: '/proj-a', projectLabel: 'proj-a', updatedAt: 10 }
      },
      folderSettings: [
        { path: '/proj-a', color: '#4c8dff', icon: 'IconChat', name: 'Campus Work', pinned: true }
      ]
    })
    const label = screen.getByText('Campus Work')
    expect(label).toBeInTheDocument()
    const row = label.closest('.sb-flatrow')
    expect(row).not.toBeNull()
    const chip = row!.querySelector('.chip') as HTMLElement
    expect(chip.style.color).toBe('rgb(76, 141, 255)')
    expect(chip.style.background).toContain('76, 141, 255')
    expect(container).toBeTruthy()
  })
})

describe('Conversation row actions (Pin/Archive/⋮)', () => {
  // Regression coverage for the row-actions bug: Pinned and Recents rows
  // must expose the same hover-revealed Pin/Archive/ConvoRowMenu actions as
  // ProjectPage.tsx's rows (ProjectPage.test.tsx's "Pin and Archive buttons"
  // test is the sibling of this one). Both sections are checked so a fix
  // that only covers one doesn't regress silently.
  it('Recents row: Pin/Archive buttons call their store actions without opening the conversation', () => {
    mount({
      conversations: {
        r1: { title: 'Recent one', projectPath: null, updatedAt: 3, pinned: false, archived: false }
      }
    })
    fireEvent.click(screen.getByLabelText('Pin'))
    expect(useAppStore.getState().setPinned).toHaveBeenCalledWith('r1', true)
    fireEvent.click(screen.getByLabelText('Archive'))
    expect(useAppStore.getState().setArchived).toHaveBeenCalledWith('r1', true)
    expect(useAppStore.getState().openConvo).not.toHaveBeenCalled()
  })

  it('Pinned row: Pin/Archive buttons call their store actions without opening the conversation', () => {
    mount({
      conversations: {
        p1: { title: 'Pinned one', projectPath: null, updatedAt: 5, pinned: true, archived: false }
      }
    })
    // The Pin button on an already-pinned row toggles it off.
    fireEvent.click(screen.getByLabelText('Unpin'))
    expect(useAppStore.getState().setPinned).toHaveBeenCalledWith('p1', false)
    fireEvent.click(screen.getByLabelText('Archive'))
    expect(useAppStore.getState().setArchived).toHaveBeenCalledWith('p1', true)
    expect(useAppStore.getState().openConvo).not.toHaveBeenCalled()
  })

  it('Recents row: the ⋮ menu opens with Rename/Delete and wires them to store actions', () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('New title')
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    mount({
      conversations: {
        r1: { title: 'Recent one', projectPath: null, updatedAt: 3, pinned: false }
      }
    })
    fireEvent.click(screen.getByLabelText('More'))
    fireEvent.click(screen.getByText('Rename'))
    expect(useAppStore.getState().renameConversation).toHaveBeenCalledWith('r1', 'New title')

    fireEvent.click(screen.getByLabelText('More'))
    fireEvent.click(screen.getByText('Delete Conversation'))
    expect(useAppStore.getState().deleteConvo).toHaveBeenCalledWith('r1')
    expect(useAppStore.getState().openConvo).not.toHaveBeenCalled()

    promptSpy.mockRestore()
    confirmSpy.mockRestore()
  })
})

describe('Pinned Projects section', () => {
  it('is hidden when no project is pinned', () => {
    mount({
      conversations: {},
      folderSettings: [{ path: '/proj-a', color: null, icon: null, name: null, pinned: false }]
    })
    expect(screen.queryByText('Pinned Projects')).not.toBeInTheDocument()
  })

  it('lists only pinned projects and opens the project page on click', () => {
    mount({
      conversations: {},
      folderSettings: [
        { path: '/proj-a', color: null, icon: null, name: 'Alpha', pinned: true },
        { path: '/proj-b', color: null, icon: null, name: 'Beta', pinned: false }
      ]
    })
    expect(screen.getByText('Pinned Projects')).toBeInTheDocument()
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.queryByText('Beta')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Alpha'))
    expect(useAppStore.getState().openProjectPage).toHaveBeenCalledWith('/proj-a')
  })

  it('the Open terminal action calls openTerminalView without opening the project page', () => {
    mount({
      conversations: {},
      folderSettings: [{ path: '/proj-a', color: null, icon: null, name: 'Alpha', pinned: true }]
    })
    fireEvent.click(screen.getByLabelText('Open terminal'))
    expect(useAppStore.getState().openTerminalView).toHaveBeenCalledWith('/proj-a')
    expect(useAppStore.getState().openProjectPage).not.toHaveBeenCalled()
  })

  it('the New conversation action calls newConversationInProject without opening the project page', () => {
    mount({
      conversations: {},
      folderSettings: [{ path: '/proj-a', color: null, icon: null, name: 'Alpha', pinned: true }]
    })
    fireEvent.click(screen.getByLabelText('New conversation'))
    expect(useAppStore.getState().newConversationInProject).toHaveBeenCalledWith('/proj-a')
    expect(useAppStore.getState().openProjectPage).not.toHaveBeenCalled()
  })

  // Regression test for plan 008: the currently-open project's row must get
  // the same `.selected` treatment conversation rows already have (see
  // "Conversation row actions" tests' `openConvo` assertions for the sibling
  // behavior this mirrors).
  it('highlights the row matching the current project view and not other pinned rows', () => {
    mount({
      conversations: {},
      folderSettings: [
        { path: '/proj-a', color: null, icon: null, name: 'Alpha', pinned: true },
        { path: '/proj-b', color: null, icon: null, name: 'Beta', pinned: true }
      ],
      view: { kind: 'project', path: '/proj-a' }
    })
    const alphaRow = screen.getByText('Alpha').closest('.sb-flatrow')
    const betaRow = screen.getByText('Beta').closest('.sb-flatrow')
    expect(alphaRow).not.toBeNull()
    expect(betaRow).not.toBeNull()
    expect(alphaRow!.className).toContain('selected')
    expect(betaRow!.className).not.toContain('selected')
  })
})

// Coverage for plan 002 (improve-animations): the FLIP collapse effect must
// resolve --ease-drawer/--dur-drawer from :root at animation time instead of
// hand-typing them, and must NOT fall back to a hardcoded value if the tokens
// fail to resolve -- it should log via console.error and snap instantly.
describe('FLIP collapse animation resolves motion tokens (plan 002)', () => {
  beforeEach(() => {
    // jsdom has neither matchMedia nor real layout, but does provide
    // requestAnimationFrame; the effect's reduced-motion early-return
    // requires matchMedia to exist at all.
    ;(window as unknown as { matchMedia: unknown }).matchMedia = vi
      .fn()
      .mockReturnValue({ matches: false })
  })

  afterEach(() => {
    document.documentElement.style.removeProperty('--ease-drawer')
    document.documentElement.style.removeProperty('--dur-drawer')
  })

  it('builds the transition string from --ease-drawer/--dur-drawer when both resolve', async () => {
    document.documentElement.style.setProperty('--ease-drawer', 'cubic-bezier(0.32, 0.72, 0, 1)')
    document.documentElement.style.setProperty('--dur-drawer', '340ms')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const container = mount({ conversations: {} })
    const sidebarEl = container.querySelector('.sidebar') as HTMLElement
    expect(sidebarEl).not.toBeNull()

    act(() => {
      useAppStore.setState({ sidebarCollapsed: true } as never)
    })
    // The transition is applied inside a requestAnimationFrame callback.
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })

    expect(sidebarEl.style.transition).toBe('transform 340ms cubic-bezier(0.32, 0.72, 0, 1)')
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('escape hatch: skips the animation and logs an error instead of using a hardcoded fallback when the tokens do not resolve', async () => {
    // Deliberately leave --ease-drawer/--dur-drawer unset on :root.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const container = mount({ conversations: {} })
    const sidebarEl = container.querySelector('.sidebar') as HTMLElement
    expect(sidebarEl).not.toBeNull()

    act(() => {
      useAppStore.setState({ sidebarCollapsed: true } as never)
    })
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })

    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls[0][0]).toMatch(/could not resolve --ease-drawer\/--dur-drawer/)
    // No animation is played and no hardcoded cubic-bezier/ms string is used.
    expect(sidebarEl.style.transition).toBe('')
    expect(sidebarEl.style.transform).toBe('translate3d(0, 0, 0)')
    errorSpy.mockRestore()
  })
})
