// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { useAppStore } from '../../../state/store'
import { BrowserPage } from './BrowserPage'

const baseSettings = {
  browserEnabled: false,
  browserAllowlist: [] as string[],
  browserBlocklist: [] as string[],
  dataPath: '/tmp/data'
}

const setSpy = vi.fn((patch: Record<string, unknown>) =>
  Promise.resolve({ ...baseSettings, ...patch })
)
const statusSpy = vi.fn(() =>
  Promise.resolve({
    installed: true,
    connected: false,
    conversationId: null,
    debuggingEnabled: false
  })
)
const clearSessionSpy = vi.fn(() => Promise.resolve())

function mount(overrides: Record<string, unknown> = {}): void {
  ;(window as unknown as { bearcode: unknown }).bearcode = {
    settings: { set: setSpy },
    browser: { status: statusSpy, clearSession: clearSessionSpy }
  }
  useAppStore.setState({ settings: { ...baseSettings, ...overrides } as never })
  render(<BrowserPage />)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
beforeEach(() => {
  statusSpy.mockResolvedValue({
    installed: true,
    connected: false,
    conversationId: null,
    debuggingEnabled: false
  })
})

describe('BrowserPage (F4)', () => {
  it('renders an enable toggle reflecting browserEnabled=false', () => {
    mount()
    const toggle = screen.getByRole('switch', { name: /enable browser/i })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })

  it('toggling enable on persists { browserEnabled: true }', () => {
    mount()
    fireEvent.click(screen.getByRole('switch', { name: /enable browser/i }))
    expect(setSpy).toHaveBeenCalledWith({ browserEnabled: true })
  })

  it('toggling enable off persists { browserEnabled: false }', () => {
    mount({ browserEnabled: true })
    fireEvent.click(screen.getByRole('switch', { name: /enable browser/i }))
    expect(setSpy).toHaveBeenCalledWith({ browserEnabled: false })
  })

  it('adds an allowlist entry via the input + Add button', () => {
    mount()
    const input = screen.getByPlaceholderText(/add an allowed/i)
    fireEvent.change(input, { target: { value: 'https://example.com' } })
    fireEvent.click(screen.getByRole('button', { name: /add allowed domain/i }))
    expect(setSpy).toHaveBeenCalledWith({ browserAllowlist: ['https://example.com'] })
  })

  it('removes an allowlist entry', () => {
    mount({ browserAllowlist: ['https://example.com', 'https://foo.com'] })
    fireEvent.click(screen.getByRole('button', { name: /remove https:\/\/example\.com/i }))
    expect(setSpy).toHaveBeenCalledWith({ browserAllowlist: ['https://foo.com'] })
  })

  it('adds a blocklist entry', () => {
    mount()
    const input = screen.getByPlaceholderText(/add a blocked/i)
    fireEvent.change(input, { target: { value: 'https://evil.com' } })
    fireEvent.click(screen.getByRole('button', { name: /add blocked domain/i }))
    expect(setSpy).toHaveBeenCalledWith({ browserBlocklist: ['https://evil.com'] })
  })

  it('does not add a duplicate or empty allowlist entry', () => {
    mount({ browserAllowlist: ['https://example.com'] })
    const input = screen.getByPlaceholderText(/add an allowed/i)
    const addBtn = screen.getByRole('button', { name: /add allowed domain/i })
    // empty
    fireEvent.click(addBtn)
    expect(setSpy).not.toHaveBeenCalled()
    // duplicate
    fireEvent.change(input, { target: { value: 'https://example.com' } })
    fireEvent.click(addBtn)
    expect(setSpy).not.toHaveBeenCalled()
  })

  it('Clear session calls api.browser.clearSession', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: /clear session/i }))
    expect(clearSessionSpy).toHaveBeenCalled()
  })

  it('shows engine install + connection status', async () => {
    mount()
    await waitFor(() => expect(statusSpy).toHaveBeenCalled())
    expect(await screen.findByText(/installed/i)).toBeTruthy()
  })

  it('documents the relaunch-to-take-effect posture on the Enable row', () => {
    mount()
    expect(screen.getByText(/take effect after you relaunch/i)).toBeTruthy()
  })

  it('shows a relaunch note when enabled but the endpoint was closed at boot', async () => {
    // setting = ON, boot endpoint = OFF → tools refuse until relaunch.
    mount({ browserEnabled: true })
    await waitFor(() => expect(statusSpy).toHaveBeenCalled())
    expect(await screen.findByText(/finish enabling the browser/i)).toBeTruthy()
  })

  it('shows a relaunch note when disabled but the endpoint stayed open from boot', async () => {
    // setting = OFF, boot endpoint = ON → debug port open until relaunch.
    statusSpy.mockResolvedValue({
      installed: true,
      connected: false,
      conversationId: null,
      debuggingEnabled: true
    })
    mount({ browserEnabled: false })
    await waitFor(() => expect(statusSpy).toHaveBeenCalled())
    expect(await screen.findByText(/debugging port stays open/i)).toBeTruthy()
  })

  it('shows no relaunch note when the toggle matches the boot endpoint state', async () => {
    // setting = OFF, boot endpoint = OFF → in sync, no note.
    mount({ browserEnabled: false })
    await waitFor(() => expect(statusSpy).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText(/installed/i)).toBeTruthy())
    expect(screen.queryByText(/finish (enabling|turning)/i)).toBeNull()
  })
})
