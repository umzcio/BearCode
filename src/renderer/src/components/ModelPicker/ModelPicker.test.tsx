// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ModelPicker } from './ModelPicker'
import { useAppStore } from '../../state/store'

afterEach(() => {
  cleanup()
})

const usableProvider = {
  id: 'anthropic',
  displayName: 'Anthropic',
  color: '#d97757',
  requiresKey: true,
  keyConfigured: true,
  reachable: true,
  models: [{ id: 'claude-sonnet-5', label: 'Claude Sonnet 5' }]
}

describe('ModelPicker — Ursa entry', () => {
  it('shows a disabled Ursa row with an "enable" hint when ursaEnabled is false', () => {
    useAppStore.setState({
      providers: [usableProvider] as never,
      modelRef: null,
      settings: { ursaEnabled: false } as never
    })
    render(<ModelPicker />)
    fireEvent.click(screen.getByRole('button'))
    const ursaRow = screen.getByText('Ursa').closest('[role="option"]')
    expect(ursaRow?.className).toContain('disabled')
    expect(screen.getByText(/enable ursa in settings/i)).toBeInTheDocument()
  })

  it('shows a disabled Ursa row with an "add a key" hint when enabled but no provider is usable', () => {
    useAppStore.setState({
      providers: [] as never,
      modelRef: null,
      settings: { ursaEnabled: true } as never
    })
    render(<ModelPicker />)
    fireEvent.click(screen.getByRole('button'))
    const ursaRow = screen.getByText('Ursa').closest('[role="option"]')
    expect(ursaRow?.className).toContain('disabled')
    expect(screen.getByText(/add an api key/i)).toBeInTheDocument()
  })

  it('is selectable when enabled and at least one provider is usable, and selecting it sets modelRef to the sentinel', () => {
    const selectModel = vi.fn()
    useAppStore.setState({
      providers: [usableProvider] as never,
      modelRef: null,
      settings: { ursaEnabled: true } as never,
      selectModel
    })
    render(<ModelPicker />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('Ursa'))
    expect(selectModel).toHaveBeenCalledWith('ursa/auto')
  })
})
