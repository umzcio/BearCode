// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { Composer } from './Composer'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

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
      pickAttachments: vi.fn(async () => ({ picked: [], errors: [] })),
      showToast: vi.fn(),
      selectModel: vi.fn(),
      setPermissionMode: vi.fn(),
      modelMenuTick: 0,
      permMenuTick: 0,
      permissionMode: 'accept-edits',
      settings: { defaultPermissionMode: 'accept-edits' }
    })
}))

describe('Composer + menu Browser (F4 Task 10)', () => {
  it('clicking Browser inserts the /browser command chip and closes the menu', () => {
    render(<Composer conversationId="c1" onSend={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('Add context'))
    fireEvent.click(screen.getByText('Browser'))
    // The chip renders /browser…
    expect(screen.getByText('/browser')).toBeTruthy()
    // …and the menu closed (its Browser entry is gone).
    expect(screen.queryByText('Media')).toBeNull()
  })

  it('the Browser entry is no longer marked coming soon', () => {
    render(<Composer conversationId="c1" onSend={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('Add context'))
    expect(screen.queryByText('coming soon')).toBeNull()
  })
})
