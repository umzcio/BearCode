// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { Toggle } from './Toggle'

afterEach(cleanup)

describe('Toggle', () => {
  it('renders a switch reflecting checked state', () => {
    render(<Toggle checked={true} onChange={() => {}} ariaLabel="Feature" />)
    const sw = screen.getByRole('switch', { name: 'Feature' })
    expect(sw.getAttribute('aria-checked')).toBe('true')
  })

  it('calls onChange with the toggled value on click', () => {
    const onChange = vi.fn()
    render(<Toggle checked={false} onChange={onChange} ariaLabel="Feature" />)
    fireEvent.click(screen.getByRole('switch', { name: 'Feature' }))
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('does not fire onChange when disabled', () => {
    const onChange = vi.fn()
    render(<Toggle checked={false} onChange={onChange} ariaLabel="Feature" disabled />)
    fireEvent.click(screen.getByRole('switch', { name: 'Feature' }))
    expect(onChange).not.toHaveBeenCalled()
  })
})
