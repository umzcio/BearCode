import { useEffect, useState } from 'react'
import type { PreviewPayload } from '@shared/types'
import './FilePreview.css'

export function FilePreview({ fileId }: { fileId: string }): React.JSX.Element {
  const [loaded, setLoaded] = useState<{ fileId: string; payload: PreviewPayload } | null>(null)
  useEffect(() => {
    let live = true
    void window.bearcode.diffs.previewFile(fileId).then((p) => {
      if (live) setLoaded({ fileId, payload: p })
    })
    return () => {
      live = false
    }
  }, [fileId])

  // Derive the stale-clear instead of calling setState synchronously in the
  // effect: while a new fileId's preview is in flight, the last-loaded payload
  // belongs to a different file, so treat it as not-yet-loaded.
  const payload = loaded?.fileId === fileId ? loaded.payload : null

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
