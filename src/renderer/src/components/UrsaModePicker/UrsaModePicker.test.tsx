// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { useAppStore } from '../../state/store'
import { UrsaModePicker } from './UrsaModePicker'

beforeEach(() => {
  // Home view so setUrsaMode never reaches window.bearcode (id === null path),
  // unless a test opts into a conversation view below.
  useAppStore.setState({ view: { kind: 'home' }, ursaMode: 'code' })
})
afterEach(cleanup)

describe('UrsaModePicker', () => {
  it('shows the current mode label on the pill', () => {
    render(<UrsaModePicker />)
    // Only the pill renders "Code" before the menu opens.
    expect(screen.getByText('Code')).toBeTruthy()
  })

  it('lists all three modes with their one-line descriptions', () => {
    render(<UrsaModePicker />)
    fireEvent.click(screen.getByText('Code'))
    // Code now appears twice (pill + option); the other two are unique.
    expect(screen.getAllByText('Code').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('Council')).toBeTruthy()
    expect(screen.getByText('Deep Research')).toBeTruthy()
    expect(screen.getByText('Ursa routes each turn')).toBeTruthy()
    expect(screen.getByText('Three models deliberate, Fable 5 synthesizes')).toBeTruthy()
    expect(screen.getByText('Multi-step web research with citations')).toBeTruthy()
  })

  it('marks Code as the default', () => {
    render(<UrsaModePicker />)
    fireEvent.click(screen.getByText('Code'))
    expect(screen.getByText('· Default')).toBeTruthy()
  })

  it('picking a mode updates the store', () => {
    render(<UrsaModePicker />)
    fireEvent.click(screen.getByText('Code'))
    fireEvent.click(screen.getByText('Council'))
    expect(useAppStore.getState().ursaMode).toBe('council')
  })

  it('persists the pick over IPC when a conversation is open', () => {
    // Assign only window.bearcode (don't clobber the whole window -- Hint relies
    // on window.clearTimeout during unmount).
    const setUrsaMode = vi.fn(() => Promise.resolve())
    ;(window as unknown as { bearcode: unknown }).bearcode = {
      conversations: { setUrsaMode }
    }
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      ursaMode: 'code'
    } as never)
    render(<UrsaModePicker />)
    fireEvent.click(screen.getByText('Code'))
    fireEvent.click(screen.getByText('Deep Research'))
    expect(useAppStore.getState().ursaMode).toBe('deep-research')
    expect(setUrsaMode).toHaveBeenCalledWith('c1', 'deep-research')
    delete (window as unknown as { bearcode?: unknown }).bearcode
  })

  it('closes when Settings opens', () => {
    render(<UrsaModePicker />)
    fireEvent.click(screen.getByText('Code'))
    expect(screen.getByText('Council')).toBeTruthy()
    // useAppStore.setState alone doesn't synchronously flush the resulting
    // re-render under React 19 + RTL's automatic batching outside act() --
    // wrap it so the assertion below observes the post-close DOM.
    act(() => {
      useAppStore.setState({ settingsOpen: true })
    })
    expect(screen.queryByText('Council')).toBeNull()
  })
})
