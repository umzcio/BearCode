import { Suspense, lazy, useEffect, useReducer } from 'react'
import type { PreviewPayload } from '@shared/types'
import { Markdown } from '../../lib/markdown'
import './FilePreview.css'

// Keep full Monaco out of the eager bundle since most previews never need the
// read-only code view.
const MonacoCode = lazy(() => import('../MonacoCode'))

type HtmlPreviewResource = { html: string; url: string }

// HTML renders from a blob: URL (not srcDoc). A blob gives the iframe a real
// document URL, so in-page "#anchor" links scroll natively instead of blanking
// the frame (srcDoc's about:srcdoc URL blanks on fragment nav in a sandboxed
// opaque frame, and CSP script-src 'self' blocks any JS guard we'd inject).
// Still sandboxed allow-scripts, opaque origin -- no same-origin, no parent
// access -- so previewing agent-authored HTML stays safe.
function HtmlPreview({ html }: { html: string }): React.JSX.Element {
  // Blob URLs are external resources, so allocation and revocation belong to
  // the committed effect lifecycle rather than render.
  const [resource, publishResource] = useReducer(
    (_: HtmlPreviewResource | undefined, next: HtmlPreviewResource) => next,
    undefined
  )

  useEffect(() => {
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
    publishResource({ html, url })
    return () => URL.revokeObjectURL(url)
  }, [html])

  const url = resource?.html === html ? resource.url : undefined
  return (
    <div className="file-preview html">
      <iframe className="file-preview-frame" title="preview" sandbox="allow-scripts" src={url} />
    </div>
  )
}

export function PreviewContent({ payload }: { payload: PreviewPayload }): React.JSX.Element {
  if (payload.kind === 'html') return <HtmlPreview html={payload.html} />
  if (payload.kind === 'html-url')
    // An on-disk HTML file, served via bearcode-preview:// so it gets its own
    // origin + CSP: page scripts run and relative css/js/images resolve. Same
    // sandbox as the blob lane -- scripts yes, same-origin/parent access no.
    return (
      <div className="file-preview html">
        <iframe
          className="file-preview-frame"
          title="preview"
          sandbox="allow-scripts"
          src={payload.url}
        />
      </div>
    )
  if (payload.kind === 'image')
    return (
      <div className="file-preview image">
        <img src={payload.dataUrl} alt="preview" />
      </div>
    )
  if (payload.kind === 'pdf')
    return <iframe className="file-preview-frame pdf" title="preview" src={payload.dataUrl} />
  if (payload.kind === 'markdown')
    return (
      <div className="file-preview markdown">
        <Markdown text={payload.text} />
      </div>
    )
  if (payload.kind === 'code')
    return (
      <Suspense fallback={<div className="diff-loading">Loading…</div>}>
        <MonacoCode value={payload.text} language={payload.language} fitContent />
      </Suspense>
    )
  if (payload.kind === 'table')
    return (
      <div className="file-preview table-wrap">
        <table>
          {payload.rows.length ? (
            <thead>
              <tr>
                {payload.rows[0].map((cell, i) => (
                  <th key={i}>{cell}</th>
                ))}
              </tr>
            </thead>
          ) : null}
          <tbody>
            {payload.rows.slice(1).map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
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
