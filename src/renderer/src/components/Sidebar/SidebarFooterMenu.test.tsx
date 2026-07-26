// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useAppStore } from '../../state/store'
import { SidebarFooterMenu } from './SidebarFooterMenu'

const settingsSet = vi.fn(() => Promise.resolve({ theme: 'light' }))
const openSettings = vi.fn()

beforeEach(() => {
  vi.stubGlobal('bearcode', { settings: { set: settingsSet } })
  useAppStore.setState({
    settings: { profileName: 'Zach', theme: 'dark' } as never,
    openSettings
  })
  settingsSet.mockClear()
  openSettings.mockClear()
})
afterEach(cleanup)

describe('SidebarFooterMenu', () => {
  it('shows the profile name, falling back to "You" when unset', () => {
    render(<SidebarFooterMenu />)
    expect(screen.getByText('Zach')).toBeTruthy()

    cleanup()
    useAppStore.setState({ settings: { profileName: '', theme: 'dark' } as never })
    render(<SidebarFooterMenu />)
    expect(screen.getByText('You')).toBeTruthy()
  })

  it('opens the menu and calls openSettings when Settings is clicked', () => {
    render(<SidebarFooterMenu />)
    fireEvent.click(screen.getByRole('button', { name: /Zach/ }))
    fireEvent.click(screen.getByText('Settings'))
    expect(openSettings).toHaveBeenCalled()
  })

  it('Dark Mode toggle reflects current theme and flips it via setAppearance', () => {
    render(<SidebarFooterMenu />)
    fireEvent.click(screen.getByRole('button', { name: /Zach/ }))
    const toggle = screen.getByRole('menuitemcheckbox', { name: /Dark Mode/ })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    expect(settingsSet).toHaveBeenCalledWith({ theme: 'light' })
  })

  it('flips light -> dark via setAppearance', () => {
    useAppStore.setState({ settings: { profileName: 'Zach', theme: 'light' } as never })
    render(<SidebarFooterMenu />)
    fireEvent.click(screen.getByRole('button', { name: /Zach/ }))
    const toggle = screen.getByRole('menuitemcheckbox', { name: /Dark Mode/ })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    expect(settingsSet).toHaveBeenCalledWith({ theme: 'dark' })
  })

  it('never mutates theme when current theme is "system" -- routes to Settings instead', () => {
    useAppStore.setState({ settings: { profileName: 'Zach', theme: 'system' } as never })
    render(<SidebarFooterMenu />)
    fireEvent.click(screen.getByRole('button', { name: /Zach/ }))
    const toggle = screen.getByRole('menuitemcheckbox', { name: /Dark Mode/ })
    expect(toggle.getAttribute('aria-disabled')).toBeNull()
    expect(toggle.className).toContain('redirect')
    expect(toggle.className).not.toContain('disabled')
    fireEvent.click(toggle)
    expect(settingsSet).not.toHaveBeenCalled()
    expect(openSettings).toHaveBeenCalled()
  })

  it('never mutates theme when current theme is "custom" -- routes to Settings instead', () => {
    useAppStore.setState({ settings: { profileName: 'Zach', theme: 'custom' } as never })
    render(<SidebarFooterMenu />)
    fireEvent.click(screen.getByRole('button', { name: /Zach/ }))
    const toggle = screen.getByRole('menuitemcheckbox', { name: /Dark Mode/ })
    expect(toggle.getAttribute('aria-disabled')).toBeNull()
    expect(toggle.className).toContain('redirect')
    expect(toggle.className).not.toContain('disabled')
    fireEvent.click(toggle)
    expect(settingsSet).not.toHaveBeenCalled()
    expect(openSettings).toHaveBeenCalled()
  })
})
