// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ModelPicker } from './ModelPicker'
import { useAppStore } from '../../state/store'

afterEach(() => {
  cleanup()
})

describe('ModelPicker — Ursa entry', () => {
  it('shows a disabled Ursa row with a hint when no roles are configured', () => {
    useAppStore.setState({
      providers: [],
      modelRef: null,
      settings: { ursaRoles: [] } as never
    })
    render(<ModelPicker />)
    fireEvent.click(screen.getByRole('button'))
    const ursaRow = screen.getByText('Ursa').closest('[role="option"]')
    expect(ursaRow?.className).toContain('disabled')
  })

  it('is selectable when at least one role is configured, and selecting it sets modelRef to the sentinel', () => {
    const selectModel = vi.fn()
    useAppStore.setState({
      providers: [],
      modelRef: null,
      settings: { ursaRoles: [{ name: 'coder', modelRef: 'openai/gpt-5.6-sol', description: '' }] } as never,
      selectModel
    })
    render(<ModelPicker />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('Ursa'))
    expect(selectModel).toHaveBeenCalledWith('ursa/auto')
  })
})
