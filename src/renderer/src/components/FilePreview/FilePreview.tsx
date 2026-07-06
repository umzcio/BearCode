import { useEffect, useState } from 'react'
import type { PreviewPayload } from '@shared/types'
import './FilePreview.css'

export function FilePreview({ fileId }: { fileId: string }): React.JSX.Element {
  const [loaded, setLoaded] = useState<{ fileId: string; payload: PreviewPayload } | null>(null)
  useEffect(() => {
    let live = true
    void window.bearcode.diffs
      .previewFile(fileId)
      .then((p) => {
        if (live) setLoaded({ fileId, payload: p })
      })
      .catch(() => {
        // A read/IPC error must not leave the pane stuck on "Loading…".
        if (live) setLoaded({ fileId, payload: { kind: 'unsupported', note: 'Could not load preview' } })
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
  if (payload.kind === 'html')
    return (
      <div className="file-preview html">
        {/* Rendered in a sandboxed, opaque-origin iframe: scripts run isolated
            (no same-origin, no parent access) so previewing agent-authored
            HTML is safe. Self-contained pages (inline CSS/JS) render fully. */}
        <iframe
          className="file-preview-frame"
          title="preview"
          sandbox="allow-scripts"
          srcDoc={payload.html}
        />
      </div>
    )
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
