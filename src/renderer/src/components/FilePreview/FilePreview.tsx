import { useEffect, useState } from 'react'
import type { PreviewPayload } from '@shared/types'
import './FilePreview.css'

export function FilePreview({ fileId }: { fileId: string }): React.JSX.Element {
  const [payload, setPayload] = useState<PreviewPayload | null>(null)
  useEffect(() => {
    let live = true
    setPayload(null)
    void window.bearcode.diffs.previewFile(fileId).then((p) => {
      if (live) setPayload(p)
    })
    return () => {
      live = false
    }
  }, [fileId])

  if (!payload) return <div className="file-preview loading">Loading preview…</div>
  if (payload.kind === 'image')
    return (
      <div className="file-preview image">
        <img src={payload.dataUrl} alt="preview" />
      </div>
    )
  if (payload.kind === 'unsupported')
    return <div className="file-preview unsupported">{payload.note}</div>
  return (
    <div className="file-preview text">
      <pre>{payload.text}</pre>
    </div>
  )
}
