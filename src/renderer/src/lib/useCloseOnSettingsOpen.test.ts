// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useCloseOnSettingsOpen } from './useCloseOnSettingsOpen'

describe('useCloseOnSettingsOpen', () => {
  it('calls onClose when settingsOpen flips true while the popover is open', () => {
    const onClose = vi.fn()
    const { rerender } = renderHook(
      ({ open, settingsOpen }) => useCloseOnSettingsOpen(open, settingsOpen, onClose),
      { initialProps: { open: true, settingsOpen: false } }
    )
    expect(onClose).not.toHaveBeenCalled()
    rerender({ open: true, settingsOpen: true })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the popover is already closed', () => {
    const onClose = vi.fn()
    const { rerender } = renderHook(
      ({ open, settingsOpen }) => useCloseOnSettingsOpen(open, settingsOpen, onClose),
      { initialProps: { open: false, settingsOpen: false } }
    )
    rerender({ open: false, settingsOpen: true })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not call onClose on mount just because settingsOpen starts true', () => {
    const onClose = vi.fn()
    renderHook(() => useCloseOnSettingsOpen(true, true, onClose))
    // Guards the case where Settings was already open before this popover
    // mounted -- nothing to close, and calling onClose() during mount could
    // fight the caller's own initial state.
    expect(onClose).not.toHaveBeenCalled()
  })
})
