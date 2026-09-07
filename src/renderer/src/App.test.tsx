// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from './state/store'
import App from './App'

vi.mock('./components/Home', () => ({
  Home: () => null
}))
vi.mock('./components/Terminal/TerminalView', () => ({
  TerminalView: () => null
}))
vi.mock('./components/ConversationView', () => ({
  ConversationView: () => null
}))

beforeEach(() => {
  vi.stubGlobal('bearcode', {
    models: {
      manageable: vi.fn().mockResolvedValue([])
    }
  })
  vi.stubGlobal('innerWidth', 1200)
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  )
  useAppStore.setState({
    sidebarCollapsed: false,
    sidebarWidth: 300,
    view: { kind: 'home' },
    conversations: {},
    convoOrder: [],
    folderSettings: [],
    settings: null,
    workspacePath: null,
    workspaceTrusted: false,
    workspaceHasAgentsConfig: false,
    workspaceImportCandidates: [],
    workspaceImportBannerVisible: false,
    importReviewOpen: false,
    outsideAccess: null,
    updaterStatus: { state: 'idle' },
    updateBannerDismissed: false,
    settingsReturnView: null,
    projectSettingsPath: null,
    auxSelection: null,
    toast: null,
    init: vi.fn()
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.documentElement.style.removeProperty('--ease-drawer')
  document.documentElement.style.removeProperty('--dur-drawer')
})

describe('App window chrome ownership', () => {
  it.each([
    ['projects', '1'],
    ['models', '2']
  ])('opens the %s sidebar destination with Command-%s', (destination, key) => {
    render(<App />)

    fireEvent.keyDown(window, { key, metaKey: true })

    expect(useAppStore.getState().view).toEqual({ kind: destination })
  })

  it('Command-, opens the settings view and toggles back to where it opened from', () => {
    render(<App />)

    fireEvent.keyDown(window, { key: ',', metaKey: true })
    expect(useAppStore.getState().view).toEqual({ kind: 'settings' })
    expect(useAppStore.getState().settingsReturnView).toEqual({ kind: 'home' })

    fireEvent.keyDown(window, { key: ',', metaKey: true })
    expect(useAppStore.getState().view).toEqual({ kind: 'home' })
  })

  it('shows a plain Settings crumb in the topbar while the settings view is active', () => {
    render(<App />)
    act(() => {
      useAppStore.setState({ view: { kind: 'settings' } })
    })

    const topbar = document.querySelector('.topbar') as HTMLElement
    expect(topbar.textContent).toContain('Settings')
  })

  it('keeps a no-drag hit area inside each draggable row behind the fixed controls', () => {
    const { container } = render(<App />)
    const sidebarDragRow = container.querySelector('.sidebar-chrome-spacer')
    const topbarDragRow = container.querySelector('.topbar')

    expect(sidebarDragRow).not.toBeNull()
    expect(topbarDragRow).not.toBeNull()
    expect(sidebarDragRow!.querySelector('.window-controls-hit-area')).not.toBeNull()
    expect(topbarDragRow!.querySelector('.window-controls-hit-area')).not.toBeNull()
  })

  it('keeps one application-wide Toggle Sidebar owner and preserves its node across collapse', () => {
    render(<App />)
    const expandedToggles = screen.getAllByRole('button', { name: 'Toggle sidebar' })
    expect(expandedToggles).toHaveLength(1)
    const toggle = expandedToggles[0]

    act(() => {
      useAppStore.setState({ sidebarCollapsed: true })
    })

    const collapsedToggles = screen.getAllByRole('button', { name: 'Toggle sidebar' })
    expect(collapsedToggles).toHaveLength(1)
    expect(collapsedToggles[0]).toBe(toggle)
  })

  it.each([
    ['Command', { metaKey: true }],
    ['Control', { ctrlKey: true }]
  ])(
    'snaps the %s+B shortcut while the persistent pointer toggle still runs the sidebar FLIP',
    async (_modifier, modifier) => {
      document.documentElement.style.setProperty('--ease-drawer', 'cubic-bezier(0.32, 0.72, 0, 1)')
      document.documentElement.style.setProperty('--dur-drawer', '340ms')
      vi.mocked(window.matchMedia).mockImplementation(
        (query: string) =>
          ({
            matches: query === '(prefers-reduced-motion: reduce)' ? false : true,
            media: query
          }) as MediaQueryList
      )
      vi.stubGlobal(
        'DOMMatrixReadOnly',
        class {
          readonly m41 = 0
        }
      )

      const { container } = render(<App />)
      const sidebar = container.querySelector('.sidebar') as HTMLElement
      const toggle = screen.getByRole('button', { name: 'Toggle sidebar' })

      fireEvent.keyDown(window, { key: 'b', ...modifier })

      expect(useAppStore.getState().sidebarCollapsed).toBe(true)
      expect(sidebar.style.willChange).toBe('')
      expect(sidebar.style.transition).toBe('')
      expect(sidebar.style.transform).toBe('')
      expect(screen.getByRole('button', { name: 'Toggle sidebar' })).toBe(toggle)

      fireEvent.click(toggle)
      expect(useAppStore.getState().sidebarCollapsed).toBe(false)
      expect(sidebar.style.willChange).toBe('transform')
      expect(sidebar.style.transition).toBe('none')
      expect(sidebar.style.transform).toBe('translate3d(-301px, 0, 0)')

      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve))
      })
      expect(sidebar.style.transition).toBe('transform 340ms cubic-bezier(0.32, 0.72, 0, 1)')
      expect(sidebar.style.transform).toBe('translate3d(0, 0, 0)')
      expect(screen.getByRole('button', { name: 'Toggle sidebar' })).toBe(toggle)
    }
  )
})

describe('App conversation breadcrumb', () => {
  function showConvo(projectPath: string | null): void {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      conversations: {
        c1: {
          id: 'c1',
          title: 'Fart Blame Shifted to User',
          projectPath,
          projectLabel: projectPath ? 'BearCode' : 'No folder'
        }
      } as never
    })
  }

  it('hides the project crumb when the conversation has no folder', () => {
    render(<App />)
    act(() => showConvo(null))

    expect(screen.queryByText('No folder')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Fart Blame Shifted to User/ })).toBeTruthy()
  })

  it('shows the project crumb when the conversation belongs to a project', () => {
    render(<App />)
    act(() => showConvo('/Users/zach/GitHub/BearCode'))

    expect(screen.getByText('BearCode')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Fart Blame Shifted to User/ })).toBeTruthy()
  })

  it('renames inline from the title menu (no prompt dialog)', () => {
    const renameSpy = vi.fn()
    useAppStore.setState({ renameConversation: renameSpy })
    const promptSpy = vi.spyOn(window, 'prompt')
    render(<App />)
    act(() => showConvo(null))

    fireEvent.click(screen.getByRole('button', { name: /Fart Blame Shifted to User/ }))
    fireEvent.click(screen.getByText('Rename'))

    const field = screen.getByLabelText('Rename conversation') as HTMLInputElement
    expect(field.value).toBe('Fart Blame Shifted to User')
    fireEvent.change(field, { target: { value: 'Blame Fully Accepted' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.blur(field, { target: { value: 'Blame Fully Accepted' } })

    expect(renameSpy).toHaveBeenCalledWith('c1', 'Blame Fully Accepted')
    expect(promptSpy).not.toHaveBeenCalled()
    promptSpy.mockRestore()
  })
})
