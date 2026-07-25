import { useEffect, useState } from 'react'
import type { Event } from '@shared/types'
import { attachmentBadge } from '../../lib/attachmentBadge'

type AssistantAttachment = Extract<Event, { type: 'assistant_attachment' }>

export interface HermesAttachmentProps {
  event: AssistantAttachment
  convoId: string
}

export function HermesAttachment({ event, convoId }: HermesAttachmentProps): React.JSX.Element {
  const { attachment } = event
  const [src, setSrc] = useState<string | null>(null)
  const isImage = attachment.kind === 'image'
  const badge = attachmentBadge(attachment.name, attachment.mime)

  useEffect(() => {
    setSrc(null)
    if (!isImage) return undefined
    let active = true
    void window.bearcode.attachments
      .read(convoId, attachment.id)
      .then((dataUrl) => {
        if (active) setSrc(dataUrl)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [attachment.id, convoId, isImage])

  if (isImage) {
    return (
      <div className="msg-command-pill msg-attachment-pill" data-event-id={event.id}>
        {src ? <img className="msg-attachment-thumb" src={src} alt={attachment.name} /> : null}
        <span className="msg-attachment-name">{attachment.name}</span>
      </div>
    )
  }

  return (
    <button
      type="button"
      className="msg-command-pill msg-attachment-pill"
      aria-label={`Open ${attachment.name}`}
      data-event-id={event.id}
      onClick={() => {
        void window.bearcode.attachments.open(convoId, attachment.id).catch(() => {})
      }}
    >
      <span className={`msg-attachment-type-badge ${badge.colorClass}`}>{badge.label}</span>
      <span className="msg-attachment-name">{attachment.name}</span>
    </button>
  )
}
