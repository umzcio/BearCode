// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { Composer } from './Composer'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

interface PickedFixture {
  picked: Array<{
    ref: { id: string; name: string; mime: string; kind: string }
    previewDataUrl: string
    notice?: string
  }>
  errors: string[]
}

const picked: PickedFixture = {
  picked: [
    {
      ref: { id: 'a1', name: 'shot.png', mime: 'image/png', kind: 'image' },
      previewDataUrl: 'data:image/png;base64,AAAA'
    }
  ],
  errors: []
}
const pickAttachments = vi.fn(async () => picked)
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

describe('Composer attachments', () => {
  it('adds a thumbnail pill after Media pick and sends the ref (no preview)', async () => {
    const onSend = vi.fn()
    render(<Composer conversationId="c1" onSend={onSend} />)
    fireEvent.click(screen.getByTitle('Add context'))
    fireEvent.click(screen.getByText('Media'))
    await waitFor(() => expect(screen.getByText('shot.png')).toBeTruthy())

    const textarea = screen.getByRole('textbox')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith(
      '',
      null,
      [],
      [{ id: 'a1', name: 'shot.png', mime: 'image/png', kind: 'image' }]
    )
  })

  it('removes a pill via its remove button', async () => {
    render(<Composer conversationId="c1" onSend={vi.fn()} />)
    fireEvent.click(screen.getByTitle('Add context'))
    fireEvent.click(screen.getByText('Media'))
    await waitFor(() => expect(screen.getByText('shot.png')).toBeTruthy())
    fireEvent.click(screen.getByTitle('Remove attachment'))
    expect(screen.queryByText('shot.png')).toBeNull()
  })

  it('renders a non-image attachment as a colored type-badge+name pill and no <img>', async () => {
    pickAttachments.mockResolvedValueOnce({
      picked: [
        {
          ref: { id: 'p1', name: 'report.pdf', mime: 'application/pdf', kind: 'pdf' },
          previewDataUrl: '',
          notice: 'PDF'
        }
      ],
      errors: []
    })
    render(<Composer conversationId="c1" onSend={vi.fn()} />)
    fireEvent.click(screen.getByTitle('Add context'))
    fireEvent.click(screen.getByText('Media'))
    await waitFor(() => expect(screen.getByText('report.pdf')).toBeTruthy())
    const pill = screen.getByText('report.pdf').closest('.attachment-pill') as HTMLElement
    expect(pill.querySelector('img')).toBeNull()
    expect(pill.querySelector('.attachment-type-badge')?.textContent).toBe('PDF')
    expect(pill.querySelector('.badge-pdf')).toBeTruthy()
    // A plain type-only pick-time notice is a size/type note, not a
    // truncation warning, so it must not render on the chip face.
    expect(pill.querySelector('.attachment-note')).toBeNull()
  })

  it('shows a genuine truncation notice on the chip but drops a size-only notice', async () => {
    pickAttachments.mockResolvedValueOnce({
      picked: [
        {
          ref: { id: 't1', name: 'notes.txt', mime: 'text/plain', kind: 'text' },
          previewDataUrl: '',
          notice: 'TXT · … (truncated at 256 KB)'
        }
      ],
      errors: []
    })
    render(<Composer conversationId="c1" onSend={vi.fn()} />)
    fireEvent.click(screen.getByTitle('Add context'))
    fireEvent.click(screen.getByText('Media'))
    await waitFor(() => expect(screen.getByText('notes.txt')).toBeTruthy())
    const pill = screen.getByText('notes.txt').closest('.attachment-pill') as HTMLElement
    expect(pill.textContent).toMatch(/truncated/i)
    expect(pill.querySelector('.attachment-type-badge')?.textContent).toBe('TXT')
  })
})
