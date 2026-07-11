// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useAppStore } from '../../state/store'
import { ProjectSettingsModal } from './ProjectSettingsModal'

const folder = {
  path: '/Users/zach/Campus',
  name: null as string | null,
  color: null as string | null,
  icon: null as string | null,
  defaultModelRef: null as string | null,
  defaultEffort: null as string | null,
  defaultPermissionMode: null as string | null,
  sandboxMode: false,
  sandboxAllowNetwork: false
}

const updateSpy = vi.fn((path: string, patch: Record<string, unknown>) =>
  Promise.resolve({ ...folder, path, ...patch })
)

const goTo = (label: string): void => {
  fireEvent.click(screen.getByRole('button', { name: label }))
}

const setUserAgent = (ua: string): void => {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true })
}

beforeEach(() => {
  ;(window as unknown as { matchMedia: unknown }).matchMedia = vi
    .fn()
    .mockReturnValue({ matches: false })
  ;(window as unknown as { bearcode: unknown }).bearcode = {
    projects: {
      update: updateSpy,
      list: vi.fn(() => Promise.resolve([folder]))
    },
    settings: { set: vi.fn() }
  }
  useAppStore.setState({
    projectSettingsPath: folder.path,
    folderSettings: [folder] as never,
    providers: [] as never,
    settings: {
      defaultModelRef: null,
      defaultEffort: 'adaptive',
      defaultPermissionMode: 'accept-edits'
    } as never
  })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ProjectSettingsModal — Sandbox page', () => {
  it('the Sandbox nav item renders and switches to the page', () => {
    setUserAgent('Macintosh; Intel Mac OS X 10_15')
    render(<ProjectSettingsModal />)
    goTo('Sandbox')
    expect(screen.getAllByText('Sandbox').length).toBeGreaterThan(0)
    expect(screen.getByLabelText('Enable sandbox mode')).toBeTruthy()
  })

  it('Sandbox Mode toggle reflects folder.sandboxMode and calls updateProject on click', () => {
    setUserAgent('Macintosh; Intel Mac OS X 10_15')
    useAppStore.setState({ folderSettings: [{ ...folder, sandboxMode: true }] as never })
    render(<ProjectSettingsModal />)
    goTo('Sandbox')
    const t = screen.getByLabelText('Enable sandbox mode')
    expect(t.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(t)
    expect(updateSpy).toHaveBeenCalledWith('/Users/zach/Campus', { sandboxMode: false })
  })

  it('Allow-network toggle is disabled when sandboxMode is false, enabled when true, and persists', () => {
    setUserAgent('Macintosh; Intel Mac OS X 10_15')
    render(<ProjectSettingsModal />)
    goTo('Sandbox')
    const net = screen.getByLabelText('Allow network in sandbox')
    expect(net.hasAttribute('disabled')).toBe(true)

    useAppStore.setState({ folderSettings: [{ ...folder, sandboxMode: true }] as never })
    cleanup()
    render(<ProjectSettingsModal />)
    goTo('Sandbox')
    const net2 = screen.getByLabelText('Allow network in sandbox')
    expect(net2.hasAttribute('disabled')).toBe(false)
    fireEvent.click(net2)
    expect(updateSpy).toHaveBeenCalledWith('/Users/zach/Campus', { sandboxAllowNetwork: true })
  })

  it('non-mac platform disables both toggles and shows the requires-macOS note', () => {
    setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36')
    useAppStore.setState({ folderSettings: [{ ...folder, sandboxMode: true }] as never })
    render(<ProjectSettingsModal />)
    goTo('Sandbox')
    expect(screen.getByLabelText('Enable sandbox mode').hasAttribute('disabled')).toBe(true)
    expect(screen.getByLabelText('Allow network in sandbox').hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('note')).toBeTruthy()
  })
})
