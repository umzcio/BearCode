// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { Select } from './Select'

const opts = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' }
] as const

afterEach(cleanup)

describe('Select keyboard', () => {
  it('opens, arrows through options, and commits on Enter', () => {
    const onChange = vi.fn()
    render(<Select value="a" options={opts} onChange={onChange} ariaLabel="Pick" />)
    const trigger = screen.getByRole('button', { name: 'Pick' })
    fireEvent.click(trigger)
    const listbox = screen.getByRole('listbox')
    fireEvent.keyDown(listbox, { key: 'ArrowDown' }) // active -> Beta
    fireEvent.keyDown(listbox, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('b')
  })

  it('Home/End jump to first/last and Space commits', () => {
    const onChange = vi.fn()
    render(<Select value="b" options={opts} onChange={onChange} ariaLabel="Pick" />)
    fireEvent.click(screen.getByRole('button', { name: 'Pick' }))
    const listbox = screen.getByRole('listbox')
    fireEvent.keyDown(listbox, { key: 'End' })
    fireEvent.keyDown(listbox, { key: ' ' })
    expect(onChange).toHaveBeenCalledWith('c')
  })
})
