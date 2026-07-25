// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { BearcodeApi, Event } from '@shared/types'
import { HermesAttachment } from './HermesAttachment'

const read = vi.fn()
const open = vi.fn(() => Promise.resolve())

function attachment(
  overrides: Partial<Extract<Event, { type: 'assistant_attachment' }>['attachment']> = {}
): Extract<Event, { type: 'assistant_attachment' }> {
  return {
    type: 'assistant_attachment',
    id: 'event-1',
    attachment: {
      id: 'attachment-1',
      name: 'diagram.png',
      mime: 'image/png',
      kind: 'image',
      sizeBytes: 100,
      sha256: 'abc123',
      ...overrides
    }
  }
}

beforeEach(() => {
  read.mockReset()
  open.mockClear()
  read.mockResolvedValue('data:image/png;base64,AAAA')
  ;(window as unknown as { bearcode: BearcodeApi }).bearcode = {
    attachments: { read, open }
  } as unknown as BearcodeApi
})
afterEach(cleanup)

describe('HermesAttachment', () => {
  it('lazy-loads images only through attachments.read', async () => {
    render(<HermesAttachment event={attachment()} convoId="conversation-id" />)

    expect(read).toHaveBeenCalledWith('conversation-id', 'attachment-1')
    expect(open).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'diagram.png' })).toHaveAttribute(
        'src',
        'data:image/png;base64,AAAA'
      )
    })
  })

  it('shows a document type badge and opens it only through attachments.open', () => {
    render(
      <HermesAttachment
        event={attachment({
          id: 'attachment-pdf',
          name: 'report.pdf',
          mime: 'application/pdf',
          kind: 'document'
        })}
        convoId="conversation-id"
      />
    )

    expect(screen.getByText('PDF')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open report.pdf' }))
    expect(open).toHaveBeenCalledWith('conversation-id', 'attachment-pdf')
    expect(read).not.toHaveBeenCalled()
  })

  it('ignores a stale image read when the attachment changes', async () => {
    let resolveFirst: ((value: string | null) => void) | undefined
    read
      .mockImplementationOnce(
        () =>
          new Promise<string | null>((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockResolvedValueOnce('data:image/png;base64,BBBB')
    const { rerender } = render(<HermesAttachment event={attachment()} convoId="conversation-id" />)

    rerender(
      <HermesAttachment
        event={attachment({ id: 'attachment-2', name: 'new.png' })}
        convoId="conversation-id"
      />
    )
    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'new.png' })).toHaveAttribute(
        'src',
        'data:image/png;base64,BBBB'
      )
    )
    await act(async () => {
      resolveFirst?.('data:image/png;base64,STALE')
    })

    expect(screen.getByRole('img', { name: 'new.png' })).toHaveAttribute(
      'src',
      'data:image/png;base64,BBBB'
    )
  })
})
