// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
import { UpdateBanner } from './UpdateBanner'
import { useAppStore } from '../state/store'

afterEach(cleanup)
beforeEach(() => {
  useAppStore.setState({
    updaterStatus: { state: 'ready', version: '1.0.1' },
    updateBannerDismissed: false,
    installUpdate: vi.fn(),
    dismissUpdateBanner: vi.fn()
  } as never)
})

describe('UpdateBanner', () => {
  it('shows the ready message with the version', () => {
    render(<UpdateBanner />)
    expect(screen.getByText(/1\.0\.1 is ready to install/i)).toBeTruthy()
  })

  it('renders nothing when state is not ready', () => {
    useAppStore.setState({ updaterStatus: { state: 'checking' } } as never)
    const { container } = render(<UpdateBanner />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when dismissed', () => {
    useAppStore.setState({ updateBannerDismissed: true } as never)
    const { container } = render(<UpdateBanner />)
    expect(container.firstChild).toBeNull()
  })

  it('Restart & Install calls installUpdate', () => {
    const installUpdate = vi.fn()
    useAppStore.setState({ installUpdate } as never)
    render(<UpdateBanner />)
    fireEvent.click(screen.getByRole('button', { name: /restart & install/i }))
    expect(installUpdate).toHaveBeenCalled()
  })

  it('Not now calls dismissUpdateBanner', () => {
    const dismissUpdateBanner = vi.fn()
    useAppStore.setState({ dismissUpdateBanner } as never)
    render(<UpdateBanner />)
    fireEvent.click(screen.getByRole('button', { name: /not now/i }))
    expect(dismissUpdateBanner).toHaveBeenCalled()
  })

  it('animates out via data-state="closing" instead of unmounting immediately on dismiss', async () => {
    const dismissUpdateBanner = vi.fn()
    useAppStore.setState({ dismissUpdateBanner } as never)
    const { container } = render(<UpdateBanner />)
    expect(container.querySelector('.trust-banner')?.getAttribute('data-state')).toBe('open')

    fireEvent.click(screen.getByRole('button', { name: /not now/i }))
    // dismissUpdateBanner is a synchronous set() in the real store; simulate
    // that here by flipping the flag directly, mirroring what the real
    // handler does.
    act(() => useAppStore.setState({ updateBannerDismissed: true } as never))

    // Still in the DOM immediately after dismissal -- only data-state flips.
    expect(container.querySelector('.trust-banner')?.getAttribute('data-state')).toBe('closing')

    // Unmounts after the 150ms exit transition.
    await waitFor(() => expect(container.querySelector('.trust-banner')).toBeNull(), {
      timeout: 500
    })
  })
})
