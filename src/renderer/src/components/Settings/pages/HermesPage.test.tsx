// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { HermesPage } from './HermesPage'
import { useAppStore } from '../../../state/store'

const saveSettings = vi.fn().mockResolvedValue(undefined)
const testHermesConnection = vi.fn().mockResolvedValue({ ok: true, message: 'Connected' })
const saveHermesToken = vi.fn().mockResolvedValue(undefined)

function mount(overrides: Record<string, unknown> = {}): void {
  useAppStore.setState({
    settings: {
      hermesEnabled: false,
      hermesGatewayUrl: '',
      hermesLabel: 'Hermes',
      hermesIcon: 'IconChat',
      ...overrides
    } as never,
    saveSettings,
    testHermesConnection,
    saveHermesToken
  })
  render(<HermesPage />)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
beforeEach(() => {
  saveSettings.mockClear()
  testHermesConnection.mockClear()
  saveHermesToken.mockClear()
})

describe('HermesPage', () => {
  it('toggling Enable Hermes saves hermesEnabled', () => {
    mount({ hermesEnabled: false })
    fireEvent.click(screen.getByRole('switch', { name: 'Enable Hermes' }))
    expect(saveSettings).toHaveBeenCalledWith({ hermesEnabled: true })
  })

  it('saves the gateway URL on blur when changed', () => {
    mount({ hermesEnabled: true, hermesGatewayUrl: '' })
    const input = screen.getByLabelText('Gateway URL')
    fireEvent.change(input, { target: { value: 'http://100.1.1.1:8642' } })
    fireEvent.blur(input)
    expect(saveSettings).toHaveBeenCalledWith({ hermesGatewayUrl: 'http://100.1.1.1:8642' })
  })

  it('saves the label on blur when changed', () => {
    mount({ hermesEnabled: true, hermesLabel: 'Hermes' })
    const input = screen.getByLabelText('Sidebar label')
    fireEvent.change(input, { target: { value: 'Assistant' } })
    fireEvent.blur(input)
    expect(saveSettings).toHaveBeenCalledWith({ hermesLabel: 'Assistant' })
  })

  it('selecting an icon saves hermesIcon', () => {
    mount({ hermesEnabled: true })
    fireEvent.click(screen.getByLabelText('IconBrain'))
    expect(saveSettings).toHaveBeenCalledWith({ hermesIcon: 'IconBrain' })
  })

  it('submitting the token field calls saveHermesToken, not saveSettings', () => {
    mount({ hermesEnabled: true })
    const tokenInput = screen.getByLabelText('Bearer token (optional)')
    fireEvent.change(tokenInput, { target: { value: 'secret' } })
    fireEvent.blur(tokenInput)
    expect(saveHermesToken).toHaveBeenCalledWith('secret')
    expect(saveSettings).not.toHaveBeenCalledWith(expect.objectContaining({ hermesToken: expect.anything() }))
  })

  it('Test Connection shows the result', async () => {
    mount({ hermesEnabled: true, hermesGatewayUrl: 'http://100.1.1.1:8642' })
    fireEvent.click(screen.getByText('Test Connection'))
    await waitFor(() => expect(screen.getByText('Connected')).toBeInTheDocument())
    expect(testHermesConnection).toHaveBeenCalledWith('http://100.1.1.1:8642', undefined)
  })

  it('Test Connection shows a failure message', async () => {
    testHermesConnection.mockResolvedValueOnce({ ok: false, message: 'ECONNREFUSED' })
    mount({ hermesEnabled: true, hermesGatewayUrl: 'http://100.1.1.1:8642' })
    fireEvent.click(screen.getByText('Test Connection'))
    await waitFor(() => expect(screen.getByText('ECONNREFUSED')).toBeInTheDocument())
  })
})
