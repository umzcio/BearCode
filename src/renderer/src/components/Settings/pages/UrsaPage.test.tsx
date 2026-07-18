// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { UrsaPage } from './UrsaPage'
import { useAppStore } from '../../../state/store'

afterEach(cleanup)

describe('UrsaPage', () => {
  it('renders existing roles and lets the user add a new one', () => {
    const saveSettings = vi.fn()
    useAppStore.setState({
      settings: {
        ursaRoles: [{ name: 'coder', modelRef: 'openai/gpt-5.6-sol', description: 'Writes code' }],
        ursaGuardrails: { roleCeilings: {} }
      } as never,
      providers: [
        {
          id: 'openai',
          displayName: 'OpenAI',
          color: '#9ad0b7',
          requiresKey: true,
          keyConfigured: true,
          reachable: true,
          models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }]
        }
      ] as never,
      saveSettings
    })
    render(<UrsaPage />)
    expect(screen.getByDisplayValue('coder')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Add role'))
    expect(saveSettings).not.toHaveBeenCalled() // adding a blank row is local draft state, not saved until named
  })

  it('rejects a duplicate role name via FieldHint', () => {
    useAppStore.setState({
      settings: {
        ursaRoles: [{ name: 'coder', modelRef: 'openai/gpt-5.6-sol', description: '' }],
        ursaGuardrails: { roleCeilings: {} }
      } as never,
      providers: [] as never,
      saveSettings: vi.fn()
    })
    render(<UrsaPage />)
    fireEvent.click(screen.getByText('Add role'))
    const nameInputs = screen.getAllByPlaceholderText('Role name')
    fireEvent.change(nameInputs[nameInputs.length - 1], { target: { value: 'coder' } })
    expect(screen.getByText(/already a role named "coder"/i)).toBeInTheDocument()
  })

  it('Blocking 1 regression: a newly named role with no model picked yet is not saved (and not lost)', () => {
    const saveSettings = vi.fn()
    useAppStore.setState({
      settings: { ursaRoles: [], ursaGuardrails: { roleCeilings: {} } } as never,
      providers: [
        {
          id: 'openai',
          displayName: 'OpenAI',
          color: '#9ad0b7',
          requiresKey: true,
          keyConfigured: true,
          reachable: true,
          models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }]
        }
      ] as never,
      saveSettings
    })
    render(<UrsaPage />)
    fireEvent.click(screen.getByText('Add role'))
    const nameInput = screen.getByPlaceholderText('Role name')
    fireEvent.change(nameInput, { target: { value: 'grunt' } })
    fireEvent.blur(nameInput)
    // Naming alone (no model chosen yet) must not save -- saving here would
    // have the main-process coercion drop the modelRef-less role and, once
    // the coerced (empty) response replaced the store, the row would vanish.
    expect(saveSettings).not.toHaveBeenCalled()
    // The row itself must still be visible/editable, not lost.
    expect(screen.getByDisplayValue('grunt')).toBeInTheDocument()
  })

  it('Blocking 2 regression: a per-role spend ceiling can be set from the page', () => {
    const saveSettings = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({
      settings: {
        ursaRoles: [{ name: 'coder', modelRef: 'openai/gpt-5.6-sol', description: '' }],
        ursaGuardrails: { roleCeilings: {} }
      } as never,
      providers: [] as never,
      saveSettings
    })
    render(<UrsaPage />)
    expect(screen.getByText('Guardrails')).toBeInTheDocument()
    const ceilingInput = screen.getByPlaceholderText('No ceiling')
    fireEvent.change(ceilingInput, { target: { value: '5' } })
    fireEvent.blur(ceilingInput)
    expect(saveSettings).toHaveBeenCalledWith({ ursaGuardrails: { roleCeilings: { coder: 5 } } })
  })
})
