// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { Composer } from './Composer'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const picked = {
  picked: [
    { ref: { id: 'a1', name: 'shot.png', mime: 'image/png' }, previewDataUrl: 'data:image/png;base64,AAAA' }
  ],
  errors: []
}
const pickAttachments = vi.fn(async () => picked)
vi.mock('../../state/store', () => ({
  refConfigured: () => true,
  modelDisplay: () => 'Claude',
  useAppStore: (sel: (s: unknown) => unknown) =>
    sel({
      providers: [{ id: 'anthropic', keyConfigured: true }],
      modelRef: 'anthropic/claude',
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

describe('Composer attachments', () => {
  it('adds a thumbnail pill after Media pick and sends the ref (no preview)', async () => {
    const onSend = vi.fn()
    render(<Composer conversationId="c1" onSend={onSend} />)
    fireEvent.click(screen.getByTitle('Add context'))
    fireEvent.click(screen.getByText('Media'))
    await waitFor(() => expect(screen.getByText('shot.png')).toBeTruthy())

    const textarea = screen.getByRole('textbox')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('', null, [], [{ id: 'a1', name: 'shot.png', mime: 'image/png' }])
  })

  it('removes a pill via its remove button', async () => {
    render(<Composer conversationId="c1" onSend={vi.fn()} />)
    fireEvent.click(screen.getByTitle('Add context'))
    fireEvent.click(screen.getByText('Media'))
    await waitFor(() => expect(screen.getByText('shot.png')).toBeTruthy())
    fireEvent.click(screen.getByTitle('Remove attachment'))
    expect(screen.queryByText('shot.png')).toBeNull()
  })
})
