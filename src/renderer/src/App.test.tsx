// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
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
})

describe('App window chrome ownership', () => {
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
})
