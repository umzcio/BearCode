// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useAppStore } from '../../state/store'
import { AddCustomModelModal } from './AddCustomModelModal'

afterEach(cleanup)

describe('AddCustomModelModal', () => {
  it('disables Add until id, label, and a positive context window are filled', () => {
    useAppStore.setState({ manageableModels: [] } as never)
    render(<AddCustomModelModal onClose={vi.fn()} />)
    expect(screen.getByText('Add model')).toBeDisabled()
    fireEvent.change(screen.getByPlaceholderText(/model id/i), { target: { value: 'my-model' } })
    fireEvent.change(screen.getByPlaceholderText(/display name/i), { target: { value: 'My Model' } })
    fireEvent.change(screen.getByPlaceholderText(/context window/i), { target: { value: '128000' } })
    expect(screen.getByText('Add model')).not.toBeDisabled()
  })

  it('calls addCustomModel with the trimmed draft and closes', () => {
    const addCustomModel = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()
    useAppStore.setState({ manageableModels: [], addCustomModel } as never)
    render(<AddCustomModelModal onClose={onClose} />)
    fireEvent.change(screen.getByPlaceholderText(/model id/i), { target: { value: '  my-model  ' } })
    fireEvent.change(screen.getByPlaceholderText(/display name/i), { target: { value: '  My Model  ' } })
    fireEvent.change(screen.getByPlaceholderText(/context window/i), { target: { value: '128000' } })
    fireEvent.click(screen.getByText('Add model'))
    expect(addCustomModel).toHaveBeenCalledWith({
      provider: 'anthropic',
      id: 'my-model',
      label: 'My Model',
      contextWindow: 128000
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('warns when the id collides with a curated model for the selected provider', () => {
    useAppStore.setState({
      manageableModels: [
        {
          id: 'anthropic',
          displayName: 'Anthropic',
          color: '#d97757',
          models: [{ id: 'claude-sonnet-5', label: 'Claude Sonnet 5', custom: false, enabled: true }]
        }
      ]
    } as never)
    render(<AddCustomModelModal onClose={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText(/model id/i), { target: { value: 'claude-sonnet-5' } })
    expect(screen.getByText(/will override it/i)).toBeTruthy()
  })
})
