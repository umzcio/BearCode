import { useEffect, useState } from 'react'
import type { Event } from '@shared/types'
import { attachmentBadge } from '../../lib/attachmentBadge'
import { useAppStore } from '../../state/store'

type AssistantAttachment = Extract<Event, { type: 'assistant_attachment' }>

export interface HermesAttachmentProps {
  event: AssistantAttachment
  convoId: string
}

export function HermesAttachment({ event, convoId }: HermesAttachmentProps): React.JSX.Element {
  const { attachment } = event
  const openAttachmentPane = useAppStore((s) => s.openAttachmentPane)
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

  return (
    <button
      type="button"
      className="msg-command-pill msg-attachment-pill"
      aria-label={`Open ${attachment.name}`}
      data-event-id={event.id}
      onClick={() => openAttachmentPane(convoId, attachment.id)}
    >
      {isImage ? (
        src ? (
          <img className="msg-attachment-thumb" src={src} alt={attachment.name} />
        ) : null
      ) : (
        <span className={`msg-attachment-type-badge ${badge.colorClass}`}>{badge.label}</span>
      )}
      <span className="msg-attachment-name">{attachment.name}</span>
    </button>
  )
}
