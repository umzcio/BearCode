// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { Composer } from './Composer'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const pickAttachments = vi.fn(async () => ({ picked: [], errors: [] }))
vi.mock('../../state/store', () => ({
  refConfigured: () => true,
  modelDisplay: () => 'Claude',
  useAppStore: (sel: (s: unknown) => unknown) =>
    sel({
      providers: [{ id: 'anthropic', keyConfigured: true, models: [] }],
      modelRef: 'anthropic/claude',
      view: { kind: 'home' },
      openSettings: vi.fn(),
      commands: [],
      refreshCommands: vi.fn(),
      resumePickerOpen: false,
      setResumePickerOpen: vi.fn(),
      fileSuggestions: [],
      manualRules: [],
      suggestFiles: vi.fn(),
      refreshManualRules: vi.fn(),
      conversations: {},
      convoOrder: [],
      pickAttachments,
      showToast: vi.fn(),
      selectModel: vi.fn(),
      setPermissionMode: vi.fn(),
      modelMenuTick: 0,
      permMenuTick: 0,
      permissionMode: 'accept-edits',
      settings: { defaultPermissionMode: 'accept-edits' }
    })
}))

describe('Add Context menu', () => {
  it('opens on + and shows the four entries', () => {
    render(<Composer conversationId="c1" onSend={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('Add context'))
    expect(screen.getByText('Media')).toBeTruthy()
    expect(screen.getByText('Mentions')).toBeTruthy()
    expect(screen.getByText('Actions')).toBeTruthy()
    expect(screen.getByText('Browser')).toBeTruthy()
  })

  it('Media calls pickAttachments with the active conversation', () => {
    render(<Composer conversationId="c1" onSend={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('Add context'))
    fireEvent.click(screen.getByText('Media'))
    expect(pickAttachments).toHaveBeenCalledWith(0)
  })

  it('Media is enabled with no conversationId (Home, before the first send)', () => {
    render(<Composer onSend={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('Add context'))
    fireEvent.click(screen.getByText('Media'))
    expect(pickAttachments).toHaveBeenCalledWith(0)
  })
})
