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
      fileSuggestions: ['src/answer.ts'],
      manualRules: [],
      mcpConnectors: [],
      manualSkills: [],
      suggestFiles: vi.fn(),
      refreshManualRules: vi.fn(),
      refreshMcpConnectors: vi.fn(),
      refreshManualSkills: vi.fn(),
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
  it('preserves text, command, mentions, and attachments when dispatch returns false', async () => {
    const onSend = vi.fn(async () => false)
    render(<Composer conversationId="c1" onSend={onSend} />)

    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    fireEvent.click(screen.getByRole('option', { name: /^Media/ }))
    await screen.findByText('shot.png')

    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    fireEvent.click(screen.getByRole('option', { name: /^Mentions/ }))
    fireEvent.click(screen.getByText('Files'))
    fireEvent.click(screen.getByText('src/answer.ts'))

    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    fireEvent.click(screen.getByRole('option', { name: /^Browser/ }))

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'Please review this' } })
    fireEvent.click(screen.getByLabelText('Send'))

    await waitFor(() => expect(onSend).toHaveBeenCalledOnce())
    expect(textarea).toHaveValue('Please review this')
    expect(screen.getByText('/browser')).toBeInTheDocument()
    expect(screen.getByText('@src/answer.ts')).toBeInTheDocument()
    expect(screen.getByText('shot.png')).toBeInTheDocument()
  })

  it('keeps the draft visible and blocks duplicate submit while dispatch is pending', async () => {
    let resolveSend!: (accepted: boolean) => void
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSend = resolve
        })
    )
    render(<Composer conversationId="c1" onSend={onSend} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'Send once' } })

    fireEvent.click(screen.getByLabelText('Send'))

    expect(onSend).toHaveBeenCalledOnce()
    expect(textarea).toHaveValue('Send once')
    const sendButton = screen.getByLabelText('Send')
    expect(sendButton).toBeDisabled()
    fireEvent.click(sendButton)
    expect(onSend).toHaveBeenCalledOnce()

    resolveSend(true)

    await waitFor(() => expect(textarea).toHaveValue(''))
  })

  it('preserves edits and attachments added after a pending submit is accepted', async () => {
    let resolveSend!: (accepted: boolean) => void
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSend = resolve
        })
    )
    render(<Composer conversationId="c1" onSend={onSend} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'Original draft' } })
    fireEvent.click(screen.getByLabelText('Send'))

    fireEvent.change(textarea, { target: { value: 'Late edit' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    fireEvent.click(screen.getByRole('option', { name: /^Media/ }))
    await screen.findByText('shot.png')

    resolveSend(true)

    await waitFor(() => expect(screen.getByLabelText('Send')).not.toBeDisabled())
    expect(textarea).toHaveValue('Late edit')
    expect(screen.getByText('shot.png')).toBeInTheDocument()
  })

  it('adds a thumbnail pill after Media pick and sends the ref (no preview)', async () => {
    const onSend = vi.fn()
    render(<Composer conversationId="c1" onSend={onSend} />)
    fireEvent.click(screen.getByLabelText('Add context'))
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
    fireEvent.click(screen.getByLabelText('Add context'))
    fireEvent.click(screen.getByText('Media'))
    await waitFor(() => expect(screen.getByText('shot.png')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Remove attachment'))
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
    fireEvent.click(screen.getByLabelText('Add context'))
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
    fireEvent.click(screen.getByLabelText('Add context'))
    fireEvent.click(screen.getByText('Media'))
    await waitFor(() => expect(screen.getByText('notes.txt')).toBeTruthy())
    const pill = screen.getByText('notes.txt').closest('.attachment-pill') as HTMLElement
    expect(pill.textContent).toMatch(/truncated/i)
    expect(pill.querySelector('.attachment-type-badge')?.textContent).toBe('TXT')
  })
})
