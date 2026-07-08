// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useAppStore } from '../../state/store'
import { ProjectSettingsModal } from './ProjectSettingsModal'

const project = {
  id: 'p1',
  name: 'Campus',
  color: null as string | null,
  icon: null as string | null,
  defaultModelRef: null as string | null,
  defaultEffort: null as string | null,
  defaultPermissionMode: null as string | null,
  createdAt: 1,
  updatedAt: 1
}

const updateSpy = vi.fn((id: string, patch: Record<string, unknown>) =>
  Promise.resolve({ ...project, ...patch })
)
const setSpy = vi.fn((patch: Record<string, unknown>) => Promise.resolve(patch))

beforeEach(() => {
  // jsdom lacks matchMedia; RoarBear (inside SettingPlaceholder) reads it.
  ;(window as unknown as { matchMedia: unknown }).matchMedia = vi
    .fn()
    .mockReturnValue({ matches: false })
  ;(window as unknown as { bearcode: unknown }).bearcode = {
    projects: { update: updateSpy, rename: vi.fn(() => Promise.resolve()), list: vi.fn(() => Promise.resolve([project])) },
    settings: { set: setSpy }
  }
  useAppStore.setState({
    projectSettingsId: 'p1',
    projects: [project] as never,
    providers: [
      { id: 'anthropic', displayName: 'Anthropic', color: '#c96', models: [{ id: 'claude-opus-4-8', label: 'Opus 4.8' }] }
    ] as never,
    settings: { defaultModelRef: null, defaultEffort: 'adaptive', defaultPermissionMode: 'accept-edits' } as never
  })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ProjectSettingsModal (F9)', () => {
  it('returns null when no project is open', () => {
    useAppStore.setState({ projectSettingsId: null })
    const { container } = render(<ProjectSettingsModal />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the sections for the open project', () => {
    render(<ProjectSettingsModal />)
    expect(screen.getByText('Project Settings')).toBeTruthy()
    expect(screen.getByLabelText('Project name')).toBeTruthy()
    expect(screen.getByLabelText('Project default model')).toBeTruthy()
    expect(screen.getByLabelText('Project default effort')).toBeTruthy()
    expect(screen.getByLabelText('Project default permission mode')).toBeTruthy()
    // Phase-G placeholders present (no "coming soon").
    expect(screen.queryByText(/coming soon/i)).toBeNull()
    expect(screen.getByText('Project Connectors')).toBeTruthy()
  })

  it('picking a color persists via updateProject', () => {
    render(<ProjectSettingsModal />)
    fireEvent.click(screen.getByLabelText('Color #4c8dff'))
    expect(updateSpy).toHaveBeenCalledWith('p1', { color: '#4c8dff' })
  })

  it('picking an icon persists the icon name', () => {
    render(<ProjectSettingsModal />)
    fireEvent.click(screen.getByLabelText('IconBrain'))
    expect(updateSpy).toHaveBeenCalledWith('p1', { icon: 'IconBrain' })
  })

  it('setting the default effort to High writes it; Inherit writes null', () => {
    render(<ProjectSettingsModal />)
    fireEvent.click(screen.getByLabelText('Project default effort'))
    fireEvent.click(screen.getAllByRole('option').find((o) => o.textContent?.includes('High')) as HTMLElement)
    expect(updateSpy).toHaveBeenCalledWith('p1', { defaultEffort: 'high' })
    // Now Inherit → null.
    fireEvent.click(screen.getByLabelText('Project default effort'))
    fireEvent.click(
      screen.getAllByRole('option').find((o) => o.textContent?.includes('Inherit')) as HTMLElement
    )
    expect(updateSpy).toHaveBeenCalledWith('p1', { defaultEffort: null })
  })

  it('"Set as default" saves the current project settings as newProjectDefaults', () => {
    useAppStore.setState({
      projects: [{ ...project, color: '#d97757', icon: 'IconGrid', defaultEffort: 'high' }] as never
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
