// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
import { TrustBanner } from './TrustBanner'
import { useAppStore } from '../state/store'

function setState(p: Partial<ReturnType<typeof useAppStore.getState>>): void {
  useAppStore.setState(p as never)
}
afterEach(cleanup)
beforeEach(() => {
  setState({
    workspacePath: '/proj',
    workspaceTrusted: false,
    workspaceHasAgentsConfig: true,
    trustBannerDismissed: false,
    trustWorkspace: vi.fn(async () => {}),
    dismissTrustBanner: vi.fn()
  })
})
describe('TrustBanner', () => {
  it('shows when untrusted + has config', () => {
    render(<TrustBanner />)
    expect(screen.getByText(/hasn.t been trusted/i)).toBeTruthy()
  })
  it('hidden when trusted', () => {
    setState({ workspaceTrusted: true })
    const { container } = render(<TrustBanner />)
    expect(container.firstChild).toBeNull()
  })
  it('hidden when no project .agents config', () => {
    setState({ workspaceHasAgentsConfig: false })
    const { container } = render(<TrustBanner />)
    expect(container.firstChild).toBeNull()
  })
  it('hidden when dismissed', () => {
    setState({ trustBannerDismissed: true })
    const { container } = render(<TrustBanner />)
    expect(container.firstChild).toBeNull()
  })
  it('Trust folder calls trustWorkspace', () => {
    const trustWorkspace = vi.fn(async () => {})
    setState({ trustWorkspace })
    render(<TrustBanner />)
    fireEvent.click(screen.getByRole('button', { name: /trust folder/i }))
    expect(trustWorkspace).toHaveBeenCalled()
  })
  it('Not now calls dismissTrustBanner', () => {
    const dismissTrustBanner = vi.fn()
    setState({ dismissTrustBanner })
    render(<TrustBanner />)
    fireEvent.click(screen.getByRole('button', { name: /not now/i }))
    expect(dismissTrustBanner).toHaveBeenCalled()
  })
  it('animates out via data-state="closing" instead of unmounting immediately on dismiss', async () => {
    const dismissTrustBanner = vi.fn()
    setState({ dismissTrustBanner })
    const { container } = render(<TrustBanner />)
    expect(container.querySelector('.trust-banner')?.getAttribute('data-state')).toBe('open')

    fireEvent.click(screen.getByRole('button', { name: /not now/i }))
    // dismissTrustBanner is a synchronous set() in the real store; simulate
    // that here by flipping the flag directly, mirroring what the real
    // handler does.
    act(() => setState({ trustBannerDismissed: true }))

    // Still in the DOM immediately after dismissal -- only data-state flips.
    expect(container.querySelector('.trust-banner')?.getAttribute('data-state')).toBe('closing')

    // Unmounts after the 150ms exit transition.
    await waitFor(() => expect(container.querySelector('.trust-banner')).toBeNull(), {
      timeout: 500
    })
  })
})
