// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { ImportConfigBanner } from './ImportConfigBanner'
import { useAppStore } from '../state/store'
import type { ImportCandidate } from '@shared/types'

const candidates: ImportCandidate[] = [
  { sourcePath: '/proj/.cursor/rules/foo.md', kind: 'rule', tool: 'cursor', buildable: true }
]

function setState(p: Partial<ReturnType<typeof useAppStore.getState>>): void {
  useAppStore.setState(p as never)
}

afterEach(cleanup)
beforeEach(() => {
  setState({
    workspaceImportBannerVisible: true,
    workspaceImportCandidates: candidates,
    dismissImportBanner: vi.fn(async () => {}),
    openImportReview: vi.fn()
  })
})

describe('ImportConfigBanner', () => {
  it('shows when visible with candidates', () => {
    render(<ImportConfigBanner />)
    expect(screen.getByText(/existing agent config from Cursor/i)).toBeTruthy()
  })

  it('hidden when no candidates', () => {
    setState({ workspaceImportCandidates: [] })
    const { container } = render(<ImportConfigBanner />)
    expect(container.firstChild).toBeNull()
  })

  it('Review & Import calls openImportReview', () => {
    const openImportReview = vi.fn()
    setState({ openImportReview })
    render(<ImportConfigBanner />)
    fireEvent.click(screen.getByRole('button', { name: /review & import/i }))
    expect(openImportReview).toHaveBeenCalled()
  })

  it('disables "Not now" synchronously on click and shows pending text before the dismiss promise settles', async () => {
    let resolveDismiss: () => void = () => {}
    const dismissImportBanner = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDismiss = resolve
        })
    )
    setState({ dismissImportBanner })
    render(<ImportConfigBanner />)

    const btn = screen.getByRole('button', { name: /not now/i })
    fireEvent.click(btn)

    // Synchronous: disabled + pending text before the promise resolves.
    expect(dismissImportBanner).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: /dismissing/i })).toBeDisabled()

    // A second click while pending must not fire a duplicate dismiss call.
    fireEvent.click(screen.getByRole('button', { name: /dismissing/i }))
    expect(dismissImportBanner).toHaveBeenCalledTimes(1)

    resolveDismiss()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /not now/i })).not.toBeDisabled()
    })
  })

  it('re-enables "Not now" after the dismiss promise settles', async () => {
    const dismissImportBanner = vi.fn(async () => {})
    setState({ dismissImportBanner })
    render(<ImportConfigBanner />)

    fireEvent.click(screen.getByRole('button', { name: /not now/i }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /not now/i })).toBeTruthy()
    })
    expect(screen.getByRole('button', { name: /not now/i })).not.toBeDisabled()
  })
})
