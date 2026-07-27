// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
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
    // Not a checkbox anymore -- there is no toggle-able state in this branch,
    // so it must not be exposed as one.
    expect(screen.queryByRole('menuitemcheckbox', { name: /Dark Mode/ })).toBeNull()
    const toggle = screen.getByRole('menuitem', { name: /Dark Mode/ })
    expect(toggle.hasAttribute('aria-checked')).toBe(false)
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
    expect(screen.queryByRole('menuitemcheckbox', { name: /Dark Mode/ })).toBeNull()
    const toggle = screen.getByRole('menuitem', { name: /Dark Mode/ })
    expect(toggle.hasAttribute('aria-checked')).toBe(false)
    expect(toggle.getAttribute('aria-disabled')).toBeNull()
    expect(toggle.className).toContain('redirect')
    expect(toggle.className).not.toContain('disabled')
    fireEvent.click(toggle)
    expect(settingsSet).not.toHaveBeenCalled()
    expect(openSettings).toHaveBeenCalled()
  })

  it('keeps menuitemcheckbox role with aria-checked when theme is binary (dark/light)', () => {
    render(<SidebarFooterMenu />)
    fireEvent.click(screen.getByRole('button', { name: /Zach/ }))
    expect(screen.queryByRole('menuitem', { name: /Dark Mode/ })).toBeNull()
    const toggle = screen.getByRole('menuitemcheckbox', { name: /Dark Mode/ })
    expect(toggle.hasAttribute('aria-checked')).toBe(true)
    expect(toggle.getAttribute('aria-checked')).toBe('true')
  })

  it('shows the Dark Mode tooltip on hover -- it must not be permanently disabled by the popover\'s own open state', () => {
    vi.useFakeTimers()
    try {
      render(<SidebarFooterMenu />)
      fireEvent.click(screen.getByRole('button', { name: /Zach/ }))
      const toggle = screen.getByRole('menuitemcheckbox', { name: /Dark Mode/ })
      // Hint's onMouseEnter/onMouseLeave live on its own wrapper <span>
      // (Hint.tsx's `hint-wrap`), not on the child button -- fire directly on
      // that wrapper so the event target matches where the handler is bound.
      const wrap = toggle.closest('.hint-wrap')
      expect(wrap).toBeTruthy()
      fireEvent.mouseEnter(wrap as Element)
      act(() => {
        vi.advanceTimersByTime(500)
      })
      expect(screen.getByText('Toggle dark mode')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})
