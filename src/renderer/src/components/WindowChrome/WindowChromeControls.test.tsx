// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../state/store'
import { WindowChromeControls } from './WindowChromeControls'

const toggleSidebar = vi.fn()
const openHistory = vi.fn()

beforeEach(() => {
  toggleSidebar.mockClear()
  openHistory.mockClear()
  useAppStore.setState({
    sidebarCollapsed: false,
    toggleSidebar,
    openHistory
  })
})

afterEach(cleanup)

describe('WindowChromeControls', () => {
  it('routes Toggle Sidebar and History clicks to their store actions', () => {
    render(<WindowChromeControls />)

    fireEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }))
    expect(toggleSidebar).toHaveBeenCalledTimes(1)
    expect(openHistory).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'History' }))

    expect(toggleSidebar).toHaveBeenCalledTimes(1)
    expect(openHistory).toHaveBeenCalledTimes(1)
  })

  it('keeps one Toggle Sidebar control visible while History follows expanded state', () => {
    render(<WindowChromeControls />)

    expect(screen.getAllByRole('button', { name: 'Toggle sidebar' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'History' })).toBeInTheDocument()

    act(() => {
      useAppStore.setState({ sidebarCollapsed: true })
    })

    expect(screen.getAllByRole('button', { name: 'Toggle sidebar' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'History' })).not.toBeInTheDocument()
  })

  it('preserves the toggle node and fixed container class across collapse', () => {
    const { container } = render(<WindowChromeControls />)
    const toggle = screen.getByRole('button', { name: 'Toggle sidebar' })
    const controls = container.querySelector('.window-chrome-controls')
    expect(controls).not.toBeNull()
    const className = controls!.className

    act(() => {
      useAppStore.setState({ sidebarCollapsed: true })
    })

    expect(screen.getByRole('button', { name: 'Toggle sidebar' })).toBe(toggle)
    expect(container.querySelector('.window-chrome-controls')).toBe(controls)
    expect(controls!.className).toBe(className)
  })
})
