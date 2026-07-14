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
  defaultPermissionMode: null as string | null
}

const updateSpy = vi.fn((path: string, patch: Record<string, unknown>) =>
  Promise.resolve({ ...folder, path, ...patch })
)
const setSpy = vi.fn((patch: Record<string, unknown>) => Promise.resolve(patch))

// Rail navigation helper: click a left-nav section by its label.
const goTo = (label: string): void => {
  fireEvent.click(screen.getByRole('button', { name: label }))
}

beforeEach(() => {
  // jsdom lacks matchMedia; RoarBear (inside SettingPlaceholder) reads it.
  ;(window as unknown as { matchMedia: unknown }).matchMedia = vi
    .fn()
    .mockReturnValue({ matches: false })
  ;(window as unknown as { bearcode: unknown }).bearcode = {
    projects: {
      update: updateSpy,
      list: vi.fn(() => Promise.resolve([folder]))
    },
    settings: { set: setSpy },
    mcp: {
      list: vi.fn(() => Promise.resolve([])),
      add: vi.fn(() => Promise.resolve()),
      setEnabledConfigOnly: vi.fn(() => Promise.resolve()),
      trust: vi.fn(() => Promise.resolve({ state: 'disabled' })),
      remove: vi.fn(() => Promise.resolve())
    },
    skills: {
      list: vi.fn(() => Promise.resolve([])),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      setEnabled: vi.fn()
    }
  }
  useAppStore.setState({
    projectSettingsPath: folder.path,
    folderSettings: [folder] as never,
    providers: [
      {
        id: 'anthropic',
        displayName: 'Anthropic',
        color: '#c96',
        models: [{ id: 'claude-opus-4-8', label: 'Opus 4.8' }]
      }
    ] as never,
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

describe('ProjectSettingsModal (folder = project, left-nav shell)', () => {
  it('returns null when no folder is open', () => {
    useAppStore.setState({ projectSettingsPath: null })
    const { container } = render(<ProjectSettingsModal />)
    expect(container.firstChild).toBeNull()
  })

  it('opens on the General page with the name field (default page)', () => {
    render(<ProjectSettingsModal />)
    // 'General' appears in both the rail item and the page title.
    expect(screen.getAllByText('General').length).toBeGreaterThan(0)
    expect(screen.getByLabelText('Project name')).toBeTruthy()
  })

  it('opens a folder with no stored settings row (basename placeholder)', () => {
    useAppStore.setState({ projectSettingsPath: '/Users/zach/Unsaved', folderSettings: [] })
    render(<ProjectSettingsModal />)
    expect(screen.getByLabelText('Project name').getAttribute('placeholder')).toBe('Unsaved')
  })

  it('the rail navigates to each section', () => {
    render(<ProjectSettingsModal />)
    goTo('Defaults')
    expect(screen.getByLabelText('Project default model')).toBeTruthy()
    expect(screen.getByLabelText('Project default effort')).toBeTruthy()
    expect(screen.getByLabelText('Project default permission mode')).toBeTruthy()
    goTo('Connectors')
    // Real Connectors tab content now, not the retired placeholder.
    expect(screen.queryByText(/coming soon/i)).toBeNull()
    expect(screen.getByText('Add Server')).toBeTruthy()
  })

  it('a custom name blurs to updateProject(path, {name}); blank clears to null', () => {
    render(<ProjectSettingsModal />)
    const input = screen.getByLabelText('Project name')
    fireEvent.change(input, { target: { value: 'Campus Work' } })
    fireEvent.blur(input)
    expect(updateSpy).toHaveBeenCalledWith('/Users/zach/Campus', { name: 'Campus Work' })
  })

  it('picking a color (Appearance tab) persists via updateProject by path', () => {
    render(<ProjectSettingsModal />)
    goTo('Appearance')
    fireEvent.click(screen.getByLabelText('Color #4c8dff'))
    expect(updateSpy).toHaveBeenCalledWith('/Users/zach/Campus', { color: '#4c8dff' })
  })

  it('picking an icon (Appearance tab) persists the icon name', () => {
    render(<ProjectSettingsModal />)
    goTo('Appearance')
    fireEvent.click(screen.getByLabelText('IconBrain'))
    expect(updateSpy).toHaveBeenCalledWith('/Users/zach/Campus', { icon: 'IconBrain' })
  })

  it('default effort (Defaults tab): High writes it; Inherit writes null', () => {
    render(<ProjectSettingsModal />)
    goTo('Defaults')
    fireEvent.click(screen.getByLabelText('Project default effort'))
    fireEvent.click(
      screen.getAllByRole('option').find((o) => o.textContent?.includes('High')) as HTMLElement
    )
    expect(updateSpy).toHaveBeenCalledWith('/Users/zach/Campus', { defaultEffort: 'high' })
    fireEvent.click(screen.getByLabelText('Project default effort'))
    fireEvent.click(
      screen.getAllByRole('option').find((o) => o.textContent?.includes('Inherit')) as HTMLElement
    )
    expect(updateSpy).toHaveBeenCalledWith('/Users/zach/Campus', { defaultEffort: null })
  })

  it('"Set as default" (General tab) saves folder settings as newProjectDefaults (no name)', () => {
    useAppStore.setState({
      folderSettings: [
        { ...folder, color: '#d97757', icon: 'IconGrid', defaultEffort: 'high' }
      ] as never
    })
    render(<ProjectSettingsModal />)
    fireEvent.click(screen.getByRole('button', { name: 'Set as default' }))
    expect(setSpy).toHaveBeenCalledWith({
      newProjectDefaults: {
        color: '#d97757',
        icon: 'IconGrid',
        defaultModelRef: null,
        defaultEffort: 'high',
        defaultPermissionMode: null
      }
    })
  })
})

describe('ProjectSettingsModal — Connectors/Skills tabs', () => {
  it('Connectors tab renders real content, not the placeholder', async () => {
    render(<ProjectSettingsModal />)
    goTo('Connectors')
    expect(screen.queryByText(/arriving in a future update/i)).not.toBeInTheDocument()
    expect(await screen.findByText('Add Server')).toBeInTheDocument()
  })

  it('Skills tab renders real content, not the placeholder', async () => {
    render(<ProjectSettingsModal />)
    goTo('Skills')
    expect(screen.queryByText(/arriving in a future update/i)).not.toBeInTheDocument()
    expect(await screen.findByText('+ New skill')).toBeInTheDocument()
  })
})
