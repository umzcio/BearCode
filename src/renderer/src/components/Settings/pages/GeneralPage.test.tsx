// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { GeneralPage } from './GeneralPage'
import { useAppStore } from '../../../state/store'

afterEach(cleanup)
beforeEach(() => {
  useAppStore.setState({
    settings: { dataPath: '/tmp/data', profileName: '', profileCallMe: '', customInstructions: '' },
    saveSettings: vi.fn(async () => {}),
    deleteAllConversations: vi.fn(async () => {}),
    appVersion: '1.0.0',
    updaterStatus: { state: 'up-to-date', checkedAt: Date.now() },
    checkForUpdates: vi.fn(async () => {}),
    installUpdate: vi.fn()
  } as never)
})

describe('GeneralPage software update section', () => {
  it('shows the current app version', () => {
    render(<GeneralPage />)
    expect(screen.getByText(/1\.0\.0/)).toBeTruthy()
  })

  it('shows an up-to-date status message', () => {
    render(<GeneralPage />)
    expect(screen.getByText(/up to date/i)).toBeTruthy()
  })

  it('Check for Updates calls checkForUpdates', () => {
    const checkForUpdates = vi.fn(async () => {})
    useAppStore.setState({ checkForUpdates } as never)
    render(<GeneralPage />)
    fireEvent.click(screen.getByRole('button', { name: /check for updates/i }))
    expect(checkForUpdates).toHaveBeenCalled()
  })

  it('shows a Loading state while checking', () => {
    useAppStore.setState({ updaterStatus: { state: 'checking' } } as never)
    render(<GeneralPage />)
    expect(screen.getByText(/checking/i)).toBeTruthy()
  })

  it('shows an ErrorCard on error', () => {
    useAppStore.setState({ updaterStatus: { state: 'error', message: 'network down' } } as never)
    render(<GeneralPage />)
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText('network down')).toBeTruthy()
  })

  it('shows a Restart & Install action when ready', () => {
    const installUpdate = vi.fn()
    useAppStore.setState({
      updaterStatus: { state: 'ready', version: '1.0.1' },
      installUpdate
    } as never)
    render(<GeneralPage />)
    fireEvent.click(screen.getByRole('button', { name: /restart & install/i }))
    expect(installUpdate).toHaveBeenCalled()
  })
})
