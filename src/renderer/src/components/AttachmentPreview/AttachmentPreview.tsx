import { useEffect, useState } from 'react'
import type { PreviewPayload } from '@shared/types'
import { PreviewContent } from '../FilePreview/PreviewContent'
import './AttachmentPreview.css'

interface LoadedPreview {
  conversationId: string
  attachmentId: string
  payload: PreviewPayload
}

export function AttachmentPreview({
  conversationId,
  attachmentId
}: {
  conversationId: string
  attachmentId: string
}): React.JSX.Element {
  const [loaded, setLoaded] = useState<LoadedPreview | null>(null)

  useEffect(() => {
    let live = true
    void window.bearcode.attachments
      .preview(conversationId, attachmentId)
      .then((payload) => {
        if (live) setLoaded({ conversationId, attachmentId, payload })
      })
      .catch(() => {
        if (live) {
          setLoaded({
            conversationId,
            attachmentId,
            payload: { kind: 'unsupported', note: 'Could not load preview' }
          })
        }
      })
    return () => {
      live = false
    }
  }, [attachmentId, conversationId])

  const payload =
    loaded?.conversationId === conversationId && loaded.attachmentId === attachmentId
      ? loaded.payload
      : null

  if (!payload) {
    return <div className="attachment-preview-loading">Loading preview…</div>
  }
  return <PreviewContent payload={payload} />
}
