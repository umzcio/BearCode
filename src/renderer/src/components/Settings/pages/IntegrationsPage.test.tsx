// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { IntegrationStatus } from '@shared/types'
import { IntegrationsPage } from './IntegrationsPage'

const statusSpy = vi.fn(() => Promise.resolve<IntegrationStatus[]>([]))
const deviceStartSpy = vi.fn(() =>
  Promise.resolve({
    userCode: 'ABCD-1234',
    verificationUri: 'https://github.com/login/device',
    deviceCode: 'dc-1',
    interval: 5
  })
)
const devicePollSpy = vi.fn(
  () =>
    new Promise(() => {
      /* left pending by default so tests can control resolution timing */
    })
)
const connectPatSpy = vi.fn(() =>
  Promise.resolve({ provider: 'github', connected: true, method: 'pat', login: 'zach' })
)
const connectBitbucketSpy = vi.fn(() =>
  Promise.resolve({ provider: 'bitbucket', connected: true, method: 'app-password', login: 'zach' })
)
const disconnectSpy = vi.fn(() => Promise.resolve())
const windowOpenSpy = vi.fn()

function mount(): void {
  ;(window as unknown as { bearcode: unknown }).bearcode = {
    integrations: {
      status: statusSpy,
      githubDeviceStart: deviceStartSpy,
      githubDevicePoll: devicePollSpy,
      cancelGithubDevice: vi.fn(() => Promise.resolve()),
      githubConnectPat: connectPatSpy,
      connectBitbucket: connectBitbucketSpy,
      disconnect: disconnectSpy
    }
  }
  window.open = windowOpenSpy
  render(<IntegrationsPage />)
}

beforeEach(() => {
  statusSpy.mockResolvedValue([])
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('IntegrationsPage (Task 11)', () => {
  it('renders both providers as not connected by default', async () => {
    mount()
    await waitFor(() => expect(statusSpy).toHaveBeenCalled())
    expect(screen.getAllByText('GitHub').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Bitbucket').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Not connected/).length).toBe(2)
  })

  it('shows a connected GitHub row with login + scopes', async () => {
    statusSpy.mockResolvedValue([
      { provider: 'github', connected: true, method: 'pat', login: 'zach', scopes: ['repo'] }
    ])
    mount()
    expect(await screen.findByText(/Connected as @zach/)).toBeTruthy()
    expect(screen.getByText(/repo/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /disconnect github/i })).toBeTruthy()
  })

  it('Connect GitHub opens the device flow modal and starts the device flow', async () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: /connect github/i }))
    await waitFor(() => expect(deviceStartSpy).toHaveBeenCalled())
    expect(await screen.findByText('ABCD-1234')).toBeTruthy()
    // The device flow starts polling automatically once the code arrives.
    await waitFor(() => expect(devicePollSpy).toHaveBeenCalledWith('dc-1', 5))
  })

  it('Open GitHub button opens the verification URL via window.open', async () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: /connect github/i }))
    await screen.findByText('ABCD-1234')
    fireEvent.click(screen.getByRole('button', { name: /open github/i }))
    expect(windowOpenSpy).toHaveBeenCalledWith('https://github.com/login/device', '_blank')
  })

  it('"Paste a token instead" switches to PAT mode and connects', async () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: /connect github/i }))
    await screen.findByText('ABCD-1234')
    fireEvent.click(screen.getByRole('button', { name: /paste a token instead/i }))
    const input = screen.getByPlaceholderText('ghp_…')
    fireEvent.change(input, { target: { value: 'ghp_abc123' } })
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }))
    await waitFor(() => expect(connectPatSpy).toHaveBeenCalledWith('ghp_abc123'))
    // Successful connect closes the modal and refreshes status.
    await waitFor(() => expect(statusSpy).toHaveBeenCalledTimes(2))
  })

  it('Connect Bitbucket shows an inline username + app-password form', async () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: /connect bitbucket/i }))
    const user = screen.getByPlaceholderText('Bitbucket username')
    const pw = screen.getByPlaceholderText('App password')
    fireEvent.change(user, { target: { value: 'zach' } })
    fireEvent.change(pw, { target: { value: 'app-pw-secret' } })
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }))
    await waitFor(() => expect(connectBitbucketSpy).toHaveBeenCalledWith('zach', 'app-pw-secret'))
  })

  it('Disconnect calls the disconnect IPC and refreshes', async () => {
    statusSpy.mockResolvedValue([{ provider: 'github', connected: true, login: 'zach' }])
    mount()
    const disconnectBtn = await screen.findByRole('button', { name: /disconnect github/i })
    fireEvent.click(disconnectBtn)
    expect(disconnectSpy).toHaveBeenCalledWith('github')
  })
})
