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
  sandboxAllowNetwork: false,
  trusted: true,
  outsideFolderAccess: 'ask' as const,
  outsideFolderAllowedPaths: ['/allowed/one'],
  outsideFolderDeniedPaths: ['/denied/one'],
  outsideFolderPendingPaths: [] as string[]
}

const updateSpy = vi.fn((path: string, patch: Record<string, unknown>) =>
  Promise.resolve({ ...folder, path, ...patch })
)
const removeSpy = vi.fn((_path: string, _abs: string) =>
  Promise.resolve({ policy: 'ask', allowedPaths: [], deniedPaths: [], pendingPaths: [] })
)

const goTo = (label: string): void => {
  fireEvent.click(screen.getByRole('button', { name: label }))
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
    project: {
      isTrusted: vi.fn(() => Promise.resolve(true)),
      hasConfig: vi.fn(() => Promise.resolve(true)),
      outsideAccess: {
        get: vi.fn(() =>
          Promise.resolve({ policy: 'ask', allowedPaths: [], deniedPaths: [], pendingPaths: [] })
        ),
        remove: removeSpy
      }
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

describe('ProjectSettingsModal — Security page', () => {
  it('the Security nav item renders and switches to the page, showing trust status', () => {
    render(<ProjectSettingsModal />)
    goTo('Security')
    expect(screen.getAllByText('Security').length).toBeGreaterThan(0)
    expect(screen.getByText(/Trusted/)).toBeTruthy()
  })

  it('trusted folder shows Untrust; clicking calls updateProject with trusted:false', () => {
    render(<ProjectSettingsModal />)
    goTo('Security')
    const btn = screen.getByRole('button', { name: 'Untrust' })
    fireEvent.click(btn)
    expect(updateSpy).toHaveBeenCalledWith('/Users/zach/Campus', { trusted: false })
  })

  it('untrusted folder shows Trust folder; clicking calls updateProject with trusted:true', () => {
    useAppStore.setState({ folderSettings: [{ ...folder, trusted: false }] as never })
    render(<ProjectSettingsModal />)
    goTo('Security')
    const btn = screen.getByRole('button', { name: 'Trust folder' })
    fireEvent.click(btn)
    expect(updateSpy).toHaveBeenCalledWith('/Users/zach/Campus', { trusted: true })
  })

  it('Outside-of-Folder Access Select reflects folder.outsideFolderAccess and changing it calls updateProject', () => {
    render(<ProjectSettingsModal />)
    goTo('Security')
    const trigger = screen.getByLabelText('Outside-of-folder access policy')
    expect(trigger.textContent).toMatch(/Always ask/)
    fireEvent.click(trigger)
    const denyOption = screen
      .getAllByRole('option')
      .find((o) => o.textContent?.includes('Always deny'))
    fireEvent.click(denyOption!)
    expect(updateSpy).toHaveBeenCalledWith('/Users/zach/Campus', { outsideFolderAccess: 'deny' })
  })

  it('renders allowed and denied path lists with a remove control that calls removeOutside', () => {
    render(<ProjectSettingsModal />)
    goTo('Security')
    expect(screen.getByText('/allowed/one')).toBeTruthy()
    expect(screen.getByText('/denied/one')).toBeTruthy()
    const removeButtons = screen.getAllByRole('button', { name: 'Remove' })
    expect(removeButtons.length).toBe(2)
    fireEvent.click(removeButtons[0])
    expect(removeSpy).toHaveBeenCalledWith('/Users/zach/Campus', '/allowed/one')
  })
})
