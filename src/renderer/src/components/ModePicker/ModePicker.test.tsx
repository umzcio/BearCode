// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
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
})
