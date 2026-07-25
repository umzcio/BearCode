// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BearcodeApi, PreviewPayload } from '@shared/types'
import { AttachmentPreview } from './AttachmentPreview'

const preview = vi.fn()

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  preview.mockReset()
  ;(window as unknown as { bearcode: BearcodeApi }).bearcode = {
    attachments: { preview }
  } as unknown as BearcodeApi
})

afterEach(cleanup)

describe('AttachmentPreview', () => {
  it('requests a preview with opaque conversation and attachment IDs', async () => {
    preview.mockResolvedValue({ kind: 'text', text: 'Loaded' })

    render(<AttachmentPreview conversationId="conv_123" attachmentId="att_123" />)

    expect(preview).toHaveBeenCalledWith('conv_123', 'att_123')
    expect(await screen.findByText('Loaded')).toBeInTheDocument()
  })

  it('shows loading until the matching preview request resolves', async () => {
    const request = deferred<PreviewPayload>()
    preview.mockReturnValue(request.promise)

    render(<AttachmentPreview conversationId="conv_123" attachmentId="att_123" />)

    expect(screen.getByText('Loading preview…')).toBeInTheDocument()
    await act(async () => {
      request.resolve({ kind: 'text', text: 'Matching payload' })
    })
    expect(screen.getByText('Matching payload')).toBeInTheDocument()
    expect(screen.queryByText('Loading preview…')).not.toBeInTheDocument()
  })

  it('shows a stable error message when preview IPC rejects', async () => {
    preview.mockRejectedValue(new Error('missing bytes'))

    render(<AttachmentPreview conversationId="conv_123" attachmentId="att_123" />)

    expect(await screen.findByText('Could not load preview')).toBeInTheDocument()
  })

  it.each([
    {
      label: 'conversation ID',
      initial: { conversationId: 'conv_old', attachmentId: 'att_same' },
      current: { conversationId: 'conv_new', attachmentId: 'att_same' }
    },
    {
      label: 'attachment ID',
      initial: { conversationId: 'conv_same', attachmentId: 'att_old' },
      current: { conversationId: 'conv_same', attachmentId: 'att_new' }
    }
  ])('ignores a stale request when the $label changes', async ({ initial, current }) => {
    const stale = deferred<PreviewPayload>()
    const matching = deferred<PreviewPayload>()
    preview.mockReturnValueOnce(stale.promise).mockReturnValueOnce(matching.promise)
    const { rerender } = render(<AttachmentPreview {...initial} />)

    rerender(<AttachmentPreview {...current} />)
    await act(async () => {
      stale.resolve({ kind: 'text', text: 'STALE' })
    })

    expect(screen.getByText('Loading preview…')).toBeInTheDocument()
    expect(screen.queryByText('STALE')).not.toBeInTheDocument()

    await act(async () => {
      matching.resolve({ kind: 'text', text: 'CURRENT' })
    })
    expect(screen.getByText('CURRENT')).toBeInTheDocument()
  })

  it('renders loaded payloads through the shared preview renderer', async () => {
    preview.mockResolvedValue({
      kind: 'table',
      rows: [
        ['Column', 'Value'],
        ['shared-renderer', 'yes']
      ]
    })

    render(<AttachmentPreview conversationId="conv_123" attachmentId="att_123" />)

    expect(await screen.findByRole('cell', { name: 'shared-renderer' })).toBeInTheDocument()
  })
})
