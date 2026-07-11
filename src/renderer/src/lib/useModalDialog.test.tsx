// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useModalDialog } from './useModalDialog'

function Modal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { ref, dialogProps } = useModalDialog(onClose)
  return (
    <div ref={ref} {...dialogProps} aria-label="Settings">
      <button>first</button>
      <button>last</button>
    </div>
  )
}

describe('useModalDialog', () => {
  it('exposes dialog semantics and moves focus inside on mount', () => {
    render(<Modal onClose={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: 'Settings' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    // initial focus landed on the first focusable (or the panel)
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it('traps Tab from the last element back to the first', () => {
    render(<Modal onClose={vi.fn()} />)
    const [first, last] = screen.getAllByRole('button')
    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    first.focus()
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it('restores focus to the opener on unmount', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const { unmount } = render(<Modal onClose={vi.fn()} />)
    unmount()
    expect(document.activeElement).toBe(opener)
  })
})
