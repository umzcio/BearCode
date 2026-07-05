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
})
