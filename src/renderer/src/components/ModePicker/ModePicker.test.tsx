// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useAppStore } from '../../state/store'
import { ModePicker } from './ModePicker'

// Home view so setPermissionMode never reaches window.bearcode (id === null path).
beforeEach(() => {
  useAppStore.setState({ view: { kind: 'home' }, permissionMode: 'accept-edits', permMenuTick: 0 })
})
afterEach(cleanup)

describe('ModePicker', () => {
  it('shows the current mode label on the composer button', () => {
    render(<ModePicker />)
    expect(screen.getByText('Accept edits')).toBeTruthy()
  })

  it('lists all five modes with the reference labels', () => {
    render(<ModePicker />)
    fireEvent.click(screen.getByText('Accept edits')) // open the menu
    expect(screen.getByText('Ask permissions')).toBeTruthy()
    expect(screen.getByText('Plan mode')).toBeTruthy()
    expect(screen.getByText('Auto mode')).toBeTruthy()
    expect(screen.getByText('Bypass permissions')).toBeTruthy()
    expect(screen.getByText('Enable')).toBeTruthy() // Bypass shortcut label
  })

  it('pressing 3 while open selects Plan mode', () => {
    render(<ModePicker />)
    fireEvent.click(screen.getByText('Accept edits')) // open so the keydown listener is attached
    fireEvent.keyDown(document.body, { key: '3' })
    expect(useAppStore.getState().permissionMode).toBe('plan')
  })

  it('pressing 1 selects Ask permissions', () => {
    render(<ModePicker />)
    fireEvent.click(screen.getByText('Accept edits'))
    fireEvent.keyDown(document.body, { key: '1' })
    expect(useAppStore.getState().permissionMode).toBe('ask')
  })

  it('no digit maps to Bypass — pressing 5 does nothing', () => {
    render(<ModePicker />)
    fireEvent.click(screen.getByText('Accept edits'))
    fireEvent.keyDown(document.body, { key: '5' })
    expect(useAppStore.getState().permissionMode).toBe('accept-edits')
  })

  it('shows the compact pill label but the full label on the row', () => {
    useAppStore.setState({ permissionMode: 'auto' })
    render(<ModePicker />)
    expect(screen.getByText('Auto')).toBeTruthy() // compact pill label
    fireEvent.click(screen.getByText('Auto'))
    expect(screen.getByText('Auto mode')).toBeTruthy() // full row label
  })

  it('selecting Bypass opens a confirm and does NOT switch until confirmed', () => {
    render(<ModePicker />)
    fireEvent.click(screen.getByText('Accept edits')) // open menu
    fireEvent.click(screen.getByText('Bypass permissions')) // pick the Bypass row
    expect(
      screen.getByText(
        'Enable Bypass permissions? Disables ALL command and edit safety checks for this conversation, including built-in .git/.env protection.'
      )
    ).toBeTruthy()
    expect(useAppStore.getState().permissionMode).toBe('accept-edits') // unchanged
  })

  it('confirming Bypass sets the mode to bypass', () => {
    render(<ModePicker />)
    fireEvent.click(screen.getByText('Accept edits'))
    fireEvent.click(screen.getByText('Bypass permissions'))
    fireEvent.click(screen.getByRole('button', { name: 'Enable Bypass' }))
    expect(useAppStore.getState().permissionMode).toBe('bypass')
  })

  it('cancelling Bypass keeps the previous mode', () => {
    render(<ModePicker />)
    fireEvent.click(screen.getByText('Accept edits'))
    fireEvent.click(screen.getByText('Bypass permissions'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(useAppStore.getState().permissionMode).toBe('accept-edits')
  })

  it('while Bypass is active the pill shows a warning treatment', () => {
    useAppStore.setState({ permissionMode: 'bypass' })
    const { container } = render(<ModePicker />)
    expect(container.querySelector('.pill-btn.bypass-active')).toBeTruthy()
  })

  it('from Bypass, picking a safe mode switches immediately with no confirm', () => {
    useAppStore.setState({ permissionMode: 'bypass' })
    render(<ModePicker />)
    fireEvent.click(screen.getByText('Bypass')) // compact pill label while active
    fireEvent.click(screen.getByText('Auto mode'))
    expect(useAppStore.getState().permissionMode).toBe('auto')
  })

  it('picking a mode by number while the Bypass confirm is open clears the confirm state', () => {
    render(<ModePicker />)
    fireEvent.click(screen.getByText('Accept edits')) // open menu
    fireEvent.click(screen.getByText('Bypass permissions')) // open the confirm panel
    fireEvent.keyDown(document.body, { key: '2' }) // pick Accept edits via numeric shortcut
    expect(useAppStore.getState().permissionMode).toBe('accept-edits')
    // Reopen the menu — the confirm panel must NOT still be showing.
    fireEvent.click(screen.getByText('Accept edits'))
    expect(screen.getByText('Bypass permissions')).toBeTruthy() // mode list is shown
    expect(screen.queryByText(/Disables ALL command and edit safety checks/)).toBeNull()
  })

  it('closing the menu via the pill toggle while confirming Bypass clears the confirm state', () => {
    render(<ModePicker />)
    fireEvent.click(screen.getByText('Accept edits')) // open menu
    fireEvent.click(screen.getByText('Bypass permissions')) // open the confirm panel
    fireEvent.click(screen.getByText('Accept edits')) // pill toggle closes the menu (no mode change)
    expect(useAppStore.getState().permissionMode).toBe('accept-edits')
    fireEvent.click(screen.getByText('Accept edits')) // reopen
    expect(screen.getByText('Bypass permissions')).toBeTruthy() // mode list, not the confirm
    expect(screen.queryByText(/Disables ALL command and edit safety checks/)).toBeNull()
  })
})
