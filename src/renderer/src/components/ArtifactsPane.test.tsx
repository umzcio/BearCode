// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BearcodeApi, Event } from '@shared/types'
import { useAppStore, type Convo } from '../state/store'
import { ArtifactsPane } from './ArtifactsPane'

const preview = vi.fn()
const save = vi.fn()
const showToast = vi.fn()
const realShowToast = useAppStore.getState().showToast

const returnedAttachment = {
  type: 'assistant_attachment',
  id: 'event_123',
  attachment: {
    id: 'att_123',
    name: 'verified-report.pdf',
    mime: 'application/pdf',
    kind: 'document',
    sizeBytes: 1536,
    sha256: 'a'.repeat(64)
  }
} satisfies Extract<Event, { type: 'assistant_attachment' }>

function conversation(id: string, events: Event[]): Convo {
  return {
    id,
    projectPath: null,
    projectLabel: 'Hermes',
    title: 'Returned files',
    modelRef: null,
    permissionMode: 'accept-edits',
    effort: 'adaptive',
    thinking: true,
    webSearch: false,
    ursaMode: 'code',
    hermesMode: 'native',
    projectId: null,
    pinned: false,
    archived: false,
    updatedAt: 1,
    createdAt: 1,
    loaded: true,
    events,
    runState: 'idle',
    environment: 'local',
    worktrees: []
  }
}

function seedAttachmentSelection(events: Event[] = [returnedAttachment]): void {
  useAppStore.setState({
    view: { kind: 'conversation', id: 'conv_123' },
    conversations: {
      conv_123: conversation('conv_123', events)
    },
    auxSelection: {
      kind: 'attachment',
      conversationId: 'conv_123',
      attachmentId: 'att_123'
    },
    auxPaneOpenTick: 0,
    auxPaneWidth: 560
  })
}

beforeEach(() => {
  preview.mockReset()
  preview.mockResolvedValue({ kind: 'text', text: 'Verified preview body' })
  save.mockReset()
  save.mockResolvedValue('cancelled')
  showToast.mockReset()
  ;(window as unknown as { bearcode: BearcodeApi }).bearcode = {
    attachments: { preview, save }
  } as unknown as BearcodeApi
  useAppStore.setState({ showToast } as never)
})

afterEach(() => {
  cleanup()
  useAppStore.setState({ showToast: realShowToast } as never)
})

describe('ArtifactsPane attachment mode', () => {
  it('shows persisted filename, file badge, and verified size without artifact controls', async () => {
    seedAttachmentSelection()

    const { container } = render(<ArtifactsPane />)

    expect(screen.getByText('verified-report.pdf')).toBeInTheDocument()
    expect(screen.getByText('PDF')).toBeInTheDocument()
    expect(screen.getByText('1.5 KB')).toBeInTheDocument()
    expect(await screen.findByText('Verified preview body')).toBeInTheDocument()
    expect(container.querySelector('.ap-rail')).toBeNull()
    expect(container.querySelector('.artifact-version-history')).toBeNull()
    expect(container.querySelector('.artifact-status')).toBeNull()
    expect(container.querySelector('.plan-feedback-box')).toBeNull()
    expect(container.querySelector('.plan-comment-list')).toBeNull()
  })

  it('uses the standard close control to clear attachment mode', () => {
    seedAttachmentSelection()
    render(<ArtifactsPane />)

    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }))

    expect(useAppStore.getState().auxSelection).toBeNull()
  })

  it('reports when selected-conversation event metadata is no longer available', () => {
    seedAttachmentSelection([])

    render(<ArtifactsPane />)

    expect(screen.getByText('Attachment is no longer available')).toBeInTheDocument()
    expect(preview).not.toHaveBeenCalled()
  })

  it('reopens from a persisted attachment event after transient state is rehydrated', async () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'conv_123' },
      conversations: {
        conv_123: conversation('conv_123', [returnedAttachment])
      },
      auxSelection: null,
      auxPaneOpenTick: 0
    })

    useAppStore.getState().openAttachmentPane('conv_123', 'att_123')
    render(<ArtifactsPane />)

    expect(screen.getByText('verified-report.pdf')).toBeInTheDocument()
    expect(await screen.findByText('Verified preview body')).toBeInTheDocument()
  })

  it('routes Download through opaque conversation and attachment IDs', async () => {
    seedAttachmentSelection()
    render(<ArtifactsPane />)

    fireEvent.click(screen.getByRole('button', { name: 'Download…' }))

    await waitFor(() => expect(save).toHaveBeenCalledWith('conv_123', 'att_123'))
  })

  it('shows the existing success notification after a saved download', async () => {
    save.mockResolvedValueOnce('saved')
    seedAttachmentSelection()
    render(<ArtifactsPane />)

    fireEvent.click(screen.getByRole('button', { name: 'Download…' }))

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Attachment saved'))
  })

  it('keeps cancellation silent', async () => {
    save.mockResolvedValueOnce('cancelled')
    seedAttachmentSelection()
    render(<ArtifactsPane />)

    fireEvent.click(screen.getByRole('button', { name: 'Download…' }))

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(showToast).not.toHaveBeenCalled()
  })

  it('shows the existing error notification when saving rejects', async () => {
    save.mockRejectedValueOnce(new Error('disk full'))
    seedAttachmentSelection()
    render(<ArtifactsPane />)

    fireEvent.click(screen.getByRole('button', { name: 'Download…' }))

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Could not save attachment'))
  })

  it('disables repeated downloads while the selected attachment save is pending', async () => {
    let finishSave: ((result: 'cancelled') => void) | undefined
    save.mockReturnValueOnce(
      new Promise<'cancelled'>((resolve) => {
        finishSave = resolve
      })
    )
    seedAttachmentSelection()
    render(<ArtifactsPane />)
    const download = screen.getByRole('button', { name: 'Download…' })

    fireEvent.click(download)

    expect(download).toBeDisabled()
    fireEvent.click(download)
    expect(save).toHaveBeenCalledTimes(1)

    finishSave?.('cancelled')
    await waitFor(() => expect(download).not.toBeDisabled())
  })
})
