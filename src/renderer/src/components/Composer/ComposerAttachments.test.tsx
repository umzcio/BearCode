// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { StrictMode } from 'react'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
import type { PickedAttachmentWire } from '@shared/types'
import { Composer } from './Composer'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

interface PickedFixture {
  picked: PickedAttachmentWire[]
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
const showToast = vi.fn()

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason?: unknown): void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

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
      showToast,
      selectModel: vi.fn(),
      setPermissionMode: vi.fn(),
      modelMenuTick: 0,
      permMenuTick: 0,
      permissionMode: 'accept-edits',
      settings: { defaultPermissionMode: 'accept-edits' }
    })
}))

describe('Composer attachments', () => {
  it('waits for every Media operation added before transfer reaches a stable point', async () => {
    const pendingSend = deferred<boolean>()
    const firstPick = deferred<PickedFixture>()
    const secondPick = deferred<PickedFixture>()
    const secondAttachment: PickedAttachmentWire = {
      ref: { id: 'a2', name: 'second.png', mime: 'image/png', kind: 'image' },
      previewDataUrl: 'data:image/png;base64,BBBB'
    }
    pickAttachments.mockReturnValueOnce(firstPick.promise).mockReturnValueOnce(secondPick.promise)
    const onSend = vi.fn(() => pendingSend.promise)
    const onAccepted = vi.fn()
    render(<Composer conversationId="c1" onSend={onSend} onAccepted={onAccepted} />)

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'submitted' } })
    fireEvent.click(screen.getByLabelText('Send'))
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    fireEvent.click(screen.getByRole('option', { name: /^Media/ }))
    expect(pickAttachments).toHaveBeenCalledOnce()

    await act(async () => pendingSend.resolve(true))
    expect(onAccepted).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Send')).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    fireEvent.click(screen.getByRole('option', { name: /^Media/ }))
    expect(pickAttachments).toHaveBeenCalledTimes(2)

    await act(async () => firstPick.resolve(picked))
    expect(onAccepted).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Send')).toBeDisabled()

    await act(async () =>
      secondPick.resolve({
        picked: [secondAttachment],
        errors: []
      })
    )

    await waitFor(() =>
      expect(onAccepted).toHaveBeenCalledWith({
        text: '',
        command: null,
        mentions: [],
        attachments: [picked.picked[0], secondAttachment]
      })
    )
    expect(screen.getByText('shot.png')).toBeInTheDocument()
    expect(screen.getByText('second.png')).toBeInTheDocument()
    expect(screen.getByLabelText('Send')).not.toBeDisabled()
  })

  it('transfers a Media result that settles after the Composer unmounts', async () => {
    const pendingSend = deferred<boolean>()
    const pendingPick = deferred<PickedFixture>()
    pickAttachments.mockReturnValueOnce(pendingPick.promise)
    const onAccepted = vi.fn()
    const mounted = render(
      <Composer conversationId="c1" onSend={() => pendingSend.promise} onAccepted={onAccepted} />
    )

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'submitted' } })
    fireEvent.click(screen.getByLabelText('Send'))
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    fireEvent.click(screen.getByRole('option', { name: /^Media/ }))

    await act(async () => pendingSend.resolve(true))
    mounted.unmount()
    await act(async () => pendingPick.resolve(picked))

    await waitFor(() =>
      expect(onAccepted).toHaveBeenCalledWith({
        text: '',
        command: null,
        mentions: [],
        attachments: [picked.picked[0]]
      })
    )
  })

  it('normalizes a rejected Media picker without leaving accepted transfer stuck', async () => {
    const pendingSend = deferred<boolean>()
    const pendingPick = deferred<PickedFixture>()
    pickAttachments.mockReturnValueOnce(pendingPick.promise)
    const onAccepted = vi.fn()
    render(
      <Composer conversationId="c1" onSend={() => pendingSend.promise} onAccepted={onAccepted} />
    )

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'submitted' } })
    fireEvent.click(screen.getByLabelText('Send'))
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    fireEvent.click(screen.getByRole('option', { name: /^Media/ }))

    await act(async () => pendingSend.resolve(true))
    expect(screen.getByLabelText('Send')).toBeDisabled()

    await act(async () => pendingPick.reject(new Error('picker unavailable')))

    await waitFor(() =>
      expect(onAccepted).toHaveBeenCalledWith({
        text: '',
        command: null,
        mentions: [],
        attachments: []
      })
    )
    expect(showToast).toHaveBeenCalledWith('picker unavailable')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'retry' } })
    expect(screen.getByLabelText('Send')).not.toBeDisabled()
  })

  it('reports the exact rendered remainder after an accepted pending submit', async () => {
    const pending = deferred<boolean>()
    const onAccepted = vi.fn()
    render(<Composer conversationId="c1" onSend={() => pending.promise} onAccepted={onAccepted} />)

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'submitted' } })
    fireEvent.click(screen.getByLabelText('Send'))
    fireEvent.change(textarea, { target: { value: 'late text' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    fireEvent.click(screen.getByRole('option', { name: /^Media/ }))
    await screen.findByText('shot.png')

    await act(async () => pending.resolve(true))

    expect(onAccepted).toHaveBeenCalledWith({
      text: 'late text',
      command: null,
      mentions: [],
      attachments: [picked.picked[0]]
    })
    expect(textarea).toHaveValue('late text')
    expect(screen.getByText('shot.png')).toBeInTheDocument()
  })

  it('clears an unchanged mention query when an accepted send clears its text', async () => {
    render(<Composer conversationId="c1" onSend={async () => true} />)

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'submitted @' } })
    expect(document.querySelector('.mention-menu')).not.toBeNull()

    fireEvent.click(screen.getByLabelText('Send'))

    await waitFor(() => expect(textarea).toHaveValue(''))
    expect(document.querySelector('.mention-menu')).toBeNull()
  })

  it('preserves a newer mention query created while an accepted send is pending', async () => {
    const pending = deferred<boolean>()
    render(<Composer conversationId="c1" onSend={() => pending.promise} />)

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'submitted @' } })
    fireEvent.click(screen.getByLabelText('Send'))
    fireEvent.change(textarea, { target: { value: 'late @file:' } })

    expect(screen.getByText('src/answer.ts')).toBeInTheDocument()
    await act(async () => pending.resolve(true))

    expect(textarea).toHaveValue('late @file:')
    expect(screen.getByText('src/answer.ts')).toBeInTheDocument()
    expect(document.querySelector('.mention-menu')).not.toBeNull()
  })

  it('does not report an accepted remainder when dispatch returns false', async () => {
    const onAccepted = vi.fn()
    render(<Composer conversationId="c1" onSend={async () => false} onAccepted={onAccepted} />)

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'keep this' } })
    fireEvent.click(screen.getByLabelText('Send'))

    await waitFor(() => expect(screen.getByLabelText('Send')).not.toBeDisabled())
    expect(onAccepted).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox')).toHaveValue('keep this')
  })

  it('renders every literal field supplied by an initial draft', () => {
    render(
      <Composer
        conversationId="c1"
        onSend={async () => true}
        initialDraft={{
          text: 'continue from here',
          command: { name: 'browser', kind: 'builtin' },
          mentions: [{ kind: 'file', name: 'src/answer.ts', path: 'src/answer.ts' }],
          attachments: [picked.picked[0]]
        }}
      />
    )

    expect(screen.getByRole('textbox')).toHaveValue('continue from here')
    expect(screen.getByText('/browser')).toBeInTheDocument()
    expect(screen.getByText('@src/answer.ts')).toBeInTheDocument()
    expect(screen.getByText('shot.png')).toBeInTheDocument()
  })

  it('claims an initial draft exactly once under StrictMode', () => {
    const onInitialDraftConsumed = vi.fn()
    render(
      <StrictMode>
        <Composer
          conversationId="c1"
          onSend={async () => true}
          initialDraft={{ text: 'claim me', command: null, mentions: [], attachments: [] }}
          onInitialDraftConsumed={onInitialDraftConsumed}
        />
      </StrictMode>
    )

    expect(onInitialDraftConsumed).toHaveBeenCalledOnce()
  })

  it('claims and acknowledges a handoff prop that arrives after mount', async () => {
    const onInitialDraftConsumed = vi.fn()
    const onSend = vi.fn(async () => true)
    const mounted = render(
      <Composer
        conversationId="c1"
        onSend={onSend}
        onInitialDraftConsumed={onInitialDraftConsumed}
      />
    )

    mounted.rerender(
      <Composer
        conversationId="c1"
        onSend={onSend}
        initialDraft={{
          text: 'arrived later',
          command: null,
          mentions: [],
          attachments: [picked.picked[0]]
        }}
        onInitialDraftConsumed={onInitialDraftConsumed}
      />
    )

    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('arrived later'))
    expect(screen.getByText('shot.png')).toBeInTheDocument()
    expect(onInitialDraftConsumed).toHaveBeenCalledOnce()
  })

  it('does not overwrite or acknowledge a late handoff until the live draft is empty', async () => {
    const onInitialDraftConsumed = vi.fn()
    const onSend = vi.fn(async () => true)
    const mounted = render(
      <Composer
        conversationId="c1"
        onSend={onSend}
        onInitialDraftConsumed={onInitialDraftConsumed}
      />
    )
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'destination edit' } })

    mounted.rerender(
      <Composer
        conversationId="c1"
        onSend={onSend}
        initialDraft={{
          text: 'incoming handoff',
          command: { name: 'browser', kind: 'builtin' },
          mentions: [{ kind: 'file', name: 'src/answer.ts', path: 'src/answer.ts' }],
          attachments: [picked.picked[0]]
        }}
        onInitialDraftConsumed={onInitialDraftConsumed}
      />
    )

    expect(textarea).toHaveValue('destination edit')
    expect(screen.queryByText('/browser')).toBeNull()
    expect(screen.queryByText('@src/answer.ts')).toBeNull()
    expect(screen.queryByText('shot.png')).toBeNull()
    expect(onInitialDraftConsumed).not.toHaveBeenCalled()

    fireEvent.change(textarea, { target: { value: '' } })

    await waitFor(() => expect(textarea).toHaveValue('incoming handoff'))
    expect(screen.getByText('/browser')).toBeInTheDocument()
    expect(screen.getByText('@src/answer.ts')).toBeInTheDocument()
    expect(screen.getByText('shot.png')).toBeInTheDocument()
    expect(onInitialDraftConsumed).toHaveBeenCalledOnce()
  })

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
    const onSend = vi.fn(async () => true)
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
