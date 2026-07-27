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

beforeEach(() => {
  vi.stubGlobal('bearcode', {})
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
    settingsOpen: false,
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
