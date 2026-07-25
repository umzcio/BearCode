// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { Composer } from './Composer'
import { HERMES_MODEL_REF } from '@shared/types'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const pickAttachments = vi.fn(async () => ({ picked: [], errors: [] }))
const storeState = vi.hoisted(() => ({
  current: {} as Record<string, unknown>
}))
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
      settings: { defaultPermissionMode: 'accept-edits' },
      ...storeState.current
    })
}))

beforeEach(() => {
  storeState.current = {}
})

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

  it('native Hermes exposes only Media and uses the existing picker', () => {
    storeState.current = {
      modelRef: HERMES_MODEL_REF,
      conversations: {
        native: {
          events: [],
          environment: 'local',
          modelRef: HERMES_MODEL_REF,
          hermesMode: 'native'
        }
      }
    }
    render(<Composer conversationId="native" onSend={vi.fn()} />)

    fireEvent.click(screen.getByLabelText('Add context'))
    expect(screen.getByText('Media')).toBeInTheDocument()
    expect(screen.queryByText('Mentions')).toBeNull()
    expect(screen.queryByText('Actions')).toBeNull()
    expect(screen.queryByText('Browser')).toBeNull()
    fireEvent.click(screen.getByText('Media'))

    expect(pickAttachments).toHaveBeenCalledWith(0)
    expect(screen.getByLabelText('Voice input (⌃M)')).toBeInTheDocument()
  })

  it('legacy Hermes has no attachment entry point and retains voice input', () => {
    storeState.current = {
      modelRef: HERMES_MODEL_REF,
      conversations: {
        legacy: {
          events: [],
          environment: 'local',
          modelRef: HERMES_MODEL_REF,
          hermesMode: 'legacy'
        }
      }
    }
    render(<Composer conversationId="legacy" onSend={vi.fn()} />)

    expect(screen.queryByLabelText('Add context')).toBeNull()
    expect(screen.getByLabelText('Voice input (⌃M)')).toBeInTheDocument()
    expect(pickAttachments).not.toHaveBeenCalled()
  })
})
