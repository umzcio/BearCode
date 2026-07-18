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
})
