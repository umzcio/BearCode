// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
import { HermesPage } from './HermesPage'
import { useAppStore } from '../../../state/store'

const saveSettings = vi.fn()
const testHermesConnection = vi.fn().mockResolvedValue({ ok: true, message: 'Connected' })
const saveHermesToken = vi.fn().mockResolvedValue(undefined)
const saveHermesPlatformKey = vi.fn().mockResolvedValue(undefined)

function deferred(): {
  promise: Promise<void>
  resolve: () => void
} {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function mount(overrides: Record<string, unknown> = {}): void {
  useAppStore.setState({
    settings: {
      hermesEnabled: false,
      hermesGatewayUrl: '',
      hermesNativeUrl: '',
      hermesLabel: 'Hermes',
      hermesIcon: 'IconChat',
      ...overrides
    } as never,
    saveSettings,
    testHermesConnection,
    saveHermesToken,
    saveHermesPlatformKey
  })
  render(<HermesPage />)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
beforeEach(() => {
  vi.clearAllMocks()
  saveSettings.mockImplementation(async (patch: Record<string, unknown>) => {
    const current = useAppStore.getState().settings
    useAppStore.setState({ settings: { ...current, ...patch } as never })
  })
  testHermesConnection.mockResolvedValue({ ok: true, message: 'Connected' })
  saveHermesToken.mockResolvedValue(undefined)
  saveHermesPlatformKey.mockResolvedValue(undefined)
})

describe('HermesPage', () => {
  it('defaults migrated settings without a mode to Legacy API', () => {
    mount({ hermesEnabled: true, hermesConnectionMode: undefined })
    expect(screen.getByRole('button', { name: 'Connection mode' })).toHaveTextContent('Legacy API')
    expect(screen.getByLabelText('Gateway URL')).toBeInTheDocument()
    expect(screen.queryByLabelText('Native WebSocket URL')).toBeNull()
  })

  it('selecting Native Platform persists the explicit native mode', () => {
    mount({ hermesEnabled: true, hermesConnectionMode: 'legacy' })
    fireEvent.click(screen.getByRole('button', { name: 'Connection mode' }))
    fireEvent.click(screen.getByRole('option', { name: /^Native Platform/ }))
    expect(saveSettings).toHaveBeenCalledWith({ hermesConnectionMode: 'native' })
    expect(screen.getByLabelText('Native WebSocket URL')).toBeInTheDocument()
    expect(screen.getByLabelText('Platform key')).toBeInTheDocument()
    expect(screen.queryByLabelText('Gateway URL')).toBeNull()
    expect(screen.getByText(/BearCode must be open/i)).toBeInTheDocument()
    expect(screen.getByText(/plugin must be installed on Hermes/i)).toBeInTheDocument()
  })

  it('shows legacy fields and its text-only capability warning', () => {
    mount({ hermesEnabled: true, hermesConnectionMode: 'legacy' })
    expect(screen.getByLabelText('Gateway URL')).toBeInTheDocument()
    expect(screen.getByLabelText('Bearer token (optional)')).toBeInTheDocument()
    expect(screen.queryByLabelText('Platform key')).toBeNull()
    expect(screen.getByText(/text-only/i)).toBeInTheDocument()
    expect(screen.getByText(/no file or approval guarantees/i)).toBeInTheDocument()
  })

  it('reconciles clean mode and URL drafts from an external settings refresh without hydrating secrets', async () => {
    mount({
      hermesEnabled: true,
      hermesConnectionMode: 'legacy',
      hermesGatewayUrl: 'http://legacy-old:8642',
      hermesNativeUrl: 'ws://native-old:8643',
      hermesToken: 'must-not-render',
      hermesPlatformKey: 'must-not-render'
    })

    act(() => {
      const current = useAppStore.getState().settings
      useAppStore.setState({
        settings: {
          ...current,
          hermesConnectionMode: 'native',
          hermesGatewayUrl: 'https://legacy-refreshed:8642',
          hermesNativeUrl: 'wss://native-refreshed:8643',
          hermesToken: 'still-must-not-render',
          hermesPlatformKey: 'still-must-not-render'
        } as never
      })
    })

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Connection mode' })).toHaveTextContent(
        'Native Platform'
      )
    )
    expect(screen.getByLabelText('Native WebSocket URL')).toHaveValue(
      'wss://native-refreshed:8643'
    )
    expect(screen.getByLabelText('Platform key')).toHaveValue('')

    act(() => {
      const current = useAppStore.getState().settings
      useAppStore.setState({
        settings: {
          ...current,
          hermesConnectionMode: 'legacy',
          hermesGatewayUrl: 'https://legacy-later:8642'
        } as never
      })
    })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Connection mode' })).toHaveTextContent(
        'Legacy API'
      )
    )
    expect(screen.getByLabelText('Gateway URL')).toHaveValue('https://legacy-later:8642')
    expect(screen.getByLabelText('Bearer token (optional)')).toHaveValue('')
  })

  it('preserves genuinely dirty URL and secret drafts during an external settings refresh', () => {
    mount({
      hermesEnabled: true,
      hermesConnectionMode: 'native',
      hermesNativeUrl: 'ws://native-old:8643'
    })
    fireEvent.change(screen.getByLabelText('Native WebSocket URL'), {
      target: { value: 'ws://native-dirty:8643' }
    })
    fireEvent.change(screen.getByLabelText('Platform key'), {
      target: { value: 'transient-draft-key' }
    })

    act(() => {
      const current = useAppStore.getState().settings
      useAppStore.setState({
        settings: {
          ...current,
          hermesNativeUrl: 'wss://native-external:8643',
          hermesPlatformKey: 'must-not-render'
        } as never
      })
    })

    expect(screen.getByLabelText('Native WebSocket URL')).toHaveValue(
      'ws://native-dirty:8643'
    )
    expect(screen.getByLabelText('Platform key')).toHaveValue('transient-draft-key')
  })

  it('does not overwrite a dirty mode while its save is pending, then adopts authority', async () => {
    const pending = deferred()
    saveSettings.mockImplementationOnce(() => pending.promise)
    mount({ hermesEnabled: true, hermesConnectionMode: 'legacy' })

    fireEvent.click(screen.getByRole('button', { name: 'Connection mode' }))
    fireEvent.click(screen.getByRole('option', { name: /^Native Platform/ }))

    act(() => {
      const current = useAppStore.getState().settings
      useAppStore.setState({
        settings: { ...current, hermesConnectionMode: 'legacy' } as never
      })
    })
    expect(screen.getByRole('button', { name: 'Connection mode' })).toHaveTextContent(
      'Native Platform'
    )

    await act(async () => {
      pending.resolve()
      await pending.promise
    })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Connection mode' })).toHaveTextContent(
        'Legacy API'
      )
    )
  })

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

  it('awaits URL persistence, adopts the authoritative coerced value, and clears dirty state', async () => {
    saveSettings.mockImplementationOnce(async () => {
      const current = useAppStore.getState().settings
      useAppStore.setState({
        settings: { ...current, hermesNativeUrl: 'wss://native-coerced:8643' } as never
      })
    })
    mount({
      hermesEnabled: true,
      hermesConnectionMode: 'native',
      hermesNativeUrl: 'ws://native-old:8643'
    })
    const input = screen.getByLabelText('Native WebSocket URL')
    fireEvent.change(input, { target: { value: 'wss://native-requested:8643' } })
    fireEvent.blur(input)

    await waitFor(() =>
      expect(screen.getByLabelText('Native WebSocket URL')).toHaveValue(
        'wss://native-coerced:8643'
      )
    )

    act(() => {
      const current = useAppStore.getState().settings
      useAppStore.setState({
        settings: { ...current, hermesNativeUrl: 'wss://native-later:8643' } as never
      })
    })
    await waitFor(() =>
      expect(screen.getByLabelText('Native WebSocket URL')).toHaveValue(
        'wss://native-later:8643'
      )
    )
  })

  it('rolls back a rejected mode save and surfaces an accessible controlled error', async () => {
    saveSettings.mockRejectedValueOnce(new Error('disk full'))
    mount({ hermesEnabled: true, hermesConnectionMode: 'legacy' })

    fireEvent.click(screen.getByRole('button', { name: 'Connection mode' }))
    fireEvent.click(screen.getByRole('option', { name: /^Native Platform/ }))

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Could not save Hermes connection mode: disk full'
      )
    )
    expect(screen.getByRole('button', { name: 'Connection mode' })).toHaveTextContent(
      'Legacy API'
    )
    expect(screen.getByLabelText('Gateway URL')).toBeInTheDocument()
  })

  it('rolls back a rejected URL save and surfaces an accessible controlled error', async () => {
    saveSettings.mockRejectedValueOnce(new Error('disk full'))
    mount({
      hermesEnabled: true,
      hermesConnectionMode: 'native',
      hermesNativeUrl: 'ws://native-old:8643'
    })
    const input = screen.getByLabelText('Native WebSocket URL')
    fireEvent.change(input, { target: { value: 'ws://native-new:8643' } })
    fireEvent.blur(input)

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Could not save Native WebSocket URL: disk full'
      )
    )
    expect(screen.getByLabelText('Native WebSocket URL')).toHaveValue(
      'ws://native-old:8643'
    )
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
    mount({ hermesEnabled: true, hermesConnectionMode: 'legacy' })
    const tokenInput = screen.getByLabelText('Bearer token (optional)')
    fireEvent.change(tokenInput, { target: { value: 'secret' } })
    fireEvent.blur(tokenInput)
    expect(saveHermesToken).toHaveBeenCalledWith('secret')
    expect(saveSettings).not.toHaveBeenCalledWith(expect.objectContaining({ hermesToken: expect.anything() }))
  })

  it('legacy Test Connection routes the gateway URL and bearer token', async () => {
    mount({
      hermesEnabled: true,
      hermesConnectionMode: 'legacy',
      hermesGatewayUrl: 'http://100.1.1.1:8642'
    })
    fireEvent.change(screen.getByLabelText('Bearer token (optional)'), {
      target: { value: 'legacy-draft' }
    })
    fireEvent.click(screen.getByText('Test Connection'))
    await waitFor(() => expect(screen.getByText('Connected')).toBeInTheDocument())
    expect(testHermesConnection).toHaveBeenCalledWith(
      'legacy',
      'http://100.1.1.1:8642',
      'legacy-draft'
    )
  })

  it('native Test Connection routes the native URL and platform key', async () => {
    mount({
      hermesEnabled: true,
      hermesConnectionMode: 'native',
      hermesNativeUrl: 'ws://100.1.1.1:8643'
    })
    fireEvent.change(screen.getByLabelText('Platform key'), {
      target: { value: 'native-draft' }
    })
    fireEvent.click(screen.getByText('Test Connection'))
    await waitFor(() => expect(screen.getByText('Connected')).toBeInTheDocument())
    expect(testHermesConnection).toHaveBeenCalledWith(
      'native',
      'ws://100.1.1.1:8643',
      'native-draft'
    )
  })

  it('preserves separate URL and secret drafts while switching modes', () => {
    mount({
      hermesEnabled: true,
      hermesConnectionMode: 'native',
      hermesNativeUrl: 'ws://native-old:8643',
      hermesGatewayUrl: 'http://legacy-old:8642'
    })
    fireEvent.change(screen.getByLabelText('Native WebSocket URL'), {
      target: { value: 'ws://native-new:8643' }
    })
    fireEvent.blur(screen.getByLabelText('Native WebSocket URL'))
    fireEvent.change(screen.getByLabelText('Platform key'), { target: { value: 'native-secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connection mode' }))
    fireEvent.click(screen.getByRole('option', { name: /^Legacy API/ }))
    fireEvent.change(screen.getByLabelText('Gateway URL'), {
      target: { value: 'http://legacy-new:8642' }
    })
    fireEvent.blur(screen.getByLabelText('Gateway URL'))
    fireEvent.change(screen.getByLabelText('Bearer token (optional)'), {
      target: { value: 'legacy-secret' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Connection mode' }))
    fireEvent.click(screen.getByRole('option', { name: /^Native Platform/ }))
    expect(screen.getByLabelText('Native WebSocket URL')).toHaveValue('ws://native-new:8643')
    expect(screen.getByLabelText('Platform key')).toHaveValue('native-secret')
    expect(saveSettings).toHaveBeenCalledWith({ hermesNativeUrl: 'ws://native-new:8643' })
    expect(saveSettings).toHaveBeenCalledWith({ hermesGatewayUrl: 'http://legacy-new:8642' })
  })

  it('stores the platform key in the vault without adding it to settings', () => {
    mount({ hermesEnabled: true, hermesConnectionMode: 'native' })
    const keyInput = screen.getByLabelText('Platform key')
    fireEvent.change(keyInput, { target: { value: 'native-secret' } })
    fireEvent.blur(keyInput)
    expect(saveHermesPlatformKey).toHaveBeenCalledWith('native-secret')
    expect(saveSettings).not.toHaveBeenCalledWith(
      expect.objectContaining({ hermesPlatformKey: expect.anything() })
    )
  })

  it.each([
    'Native platform unavailable — install and enable the BearCode plugin on Hermes',
    'Rejected — check the platform key in Settings',
    'Incompatible native Hermes protocol'
  ])('shows a distinct native handshake failure: %s', async (message) => {
    testHermesConnection.mockResolvedValueOnce({ ok: false, message })
    mount({
      hermesEnabled: true,
      hermesConnectionMode: 'native',
      hermesNativeUrl: 'ws://100.1.1.1:8643'
    })
    fireEvent.click(screen.getByText('Test Connection'))
    await waitFor(() => expect(screen.getByText(message)).toBeInTheDocument())
  })
})
