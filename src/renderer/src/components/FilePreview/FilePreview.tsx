import { useEffect, useState } from 'react'
import type { PreviewPayload } from '@shared/types'
import { PreviewContent } from './PreviewContent'
import { PreviewEntry } from './PreviewEntry'

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
        if (live)
          setLoaded({ fileId, payload: { kind: 'unsupported', note: 'Could not load preview' } })
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
  return (
    <PreviewEntry>
      <PreviewContent payload={payload} />
    </PreviewEntry>
  )
}
