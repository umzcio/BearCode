// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useAppStore } from '../../state/store'
import { DisplayOptions } from './DisplayOptions'

const settingsSet = vi.fn(() => Promise.resolve({ sidebarGroupBy: 'none', sidebarSort: 'alpha' }))
beforeEach(() => {
  vi.stubGlobal('window', { bearcode: { settings: { set: settingsSet } } })
  useAppStore.setState({
    settings: { sidebarGroupBy: 'project', sidebarSort: 'updated' } as never
  })
  settingsSet.mockClear()
})
afterEach(cleanup)

describe('DisplayOptions', () => {
  it('opens the menu and shows the sections', () => {
    render(<DisplayOptions />)
    fireEvent.click(screen.getByTitle('Display options'))
    expect(screen.getByText('Group By')).toBeTruthy()
    expect(screen.getByText('Sort Conversations')).toBeTruthy()
  })
  it('picking a Sort persists via settings.set', () => {
    render(<DisplayOptions />)
    fireEvent.click(screen.getByTitle('Display options'))
    fireEvent.click(screen.getByText('Alphabetical (A–Z)'))
    expect(settingsSet).toHaveBeenCalledWith({ sidebarSort: 'alpha' })
  })
  it('Environment + Status group-by are enabled (no "coming soon") and persist', () => {
    render(<DisplayOptions />)
    fireEvent.click(screen.getByTitle('Display options'))
    expect(screen.queryByText('coming soon')).toBeNull()
    fireEvent.click(screen.getByText('Environment'))
    expect(settingsSet).toHaveBeenCalledWith({ sidebarGroupBy: 'environment' })
    settingsSet.mockClear()
    fireEvent.click(screen.getByText('Status'))
    expect(settingsSet).toHaveBeenCalledWith({ sidebarGroupBy: 'status' })
  })
  it('Worktree subtitle option toggles sidebarSubtitle', () => {
    render(<DisplayOptions />)
    fireEvent.click(screen.getByTitle('Display options'))
    fireEvent.click(screen.getByText('Worktree'))
    expect(settingsSet).toHaveBeenCalledWith({ sidebarSubtitle: 'worktree' })
  })
  it('shows a Show archived item and persists via settings.set when clicked', () => {
    useAppStore.setState({
      settings: {
        sidebarGroupBy: 'project',
        sidebarSort: 'updated',
        sidebarShowArchived: false
      } as never
    })
    render(<DisplayOptions />)
    fireEvent.click(screen.getByTitle('Display options'))
    expect(screen.getByText('Show archived')).toBeTruthy()
    fireEvent.click(screen.getByText('Show archived'))
    expect(settingsSet).toHaveBeenCalledWith({ sidebarShowArchived: true })
  })
})
