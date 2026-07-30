import { useState } from 'react'
import type { Event } from '@shared/types'
import { attachmentBadge } from '../../lib/attachmentBadge'
import { useAppStore } from '../../state/store'
import { AttachmentPreview } from '../AttachmentPreview/AttachmentPreview'
import { Hint } from '../Hint'
import { IconClose } from '../icons'
import { formatBytes } from './format'

export function AttachmentPanel({
  conversationId,
  attachmentId,
  attachment
}: {
  conversationId: string
  attachmentId: string
  attachment?: Extract<Event, { type: 'assistant_attachment' }>['attachment']
}): React.JSX.Element {
  const closeReview = useAppStore((s) => s.closeReview)
  const showToast = useAppStore((s) => s.showToast)
  const [savePending, setSavePending] = useState(false)
  const badge = attachment ? attachmentBadge(attachment.name, attachment.mime) : null

  const download = async (): Promise<void> => {
    if (savePending) return
    setSavePending(true)
    try {
      const result = await window.bearcode.attachments.save(conversationId, attachmentId)
      if (result === 'saved') showToast('Attachment saved')
    } catch {
      showToast('Could not save attachment')
    } finally {
      setSavePending(false)
    }
  }

  return (
    <>
      <div className="ap-row ap-row-top ap-attachment-header">
        <span className="ap-attachment-name">{attachment?.name ?? 'Attachment'}</span>
        {attachment && badge ? (
          <>
            <span className={`ap-attachment-badge ${badge.colorClass}`}>{badge.label}</span>
            <span className="ap-attachment-size">{formatBytes(attachment.sizeBytes)}</span>
          </>
        ) : null}
        <div className="ap-spacer" />
        <div className="ap-actions">
          {attachment ? (
            <button disabled={savePending} onClick={() => void download()}>
              Download…
            </button>
          ) : null}
          <Hint label="Close panel" side="bottom">
            <button aria-label="Close panel" onClick={closeReview}>
              <IconClose />
            </button>
          </Hint>
        </div>
      </div>
      <div className="ap-attachment-body">
        {attachment ? (
          <AttachmentPreview conversationId={conversationId} attachmentId={attachmentId} />
        ) : (
          <div className="ap-attachment-missing">Attachment is no longer available</div>
        )}
      </div>
    </>
  )
}
