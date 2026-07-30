import { Suspense, lazy, useEffect, useState } from 'react'
import { languageForPath } from '@shared/fileClassification'
import { useAppStore } from '../../state/store'
import { Hint } from '../Hint'
import { IconClose } from '../icons'
import { EmptyState } from '../ui/EmptyState'
import { Loading } from '../ui/Loading'
import { baseName } from './format'
import { ApBrand } from './PaneHeader'

const MonacoCode = lazy(() => import('../MonacoCode'))

// Review mode: a single workspace file opened at a finding's exact line. It
// fetches the file's text through the jailed read-file IPC (never in the
// renderer) and hands it to MonacoCode with revealLine, so clicking a finding
// lands the cursor where it points -- read-only, no rail, no diff.
export function FilePanel({ path, line }: { path: string; line?: number }): React.JSX.Element {
  const closeReview = useAppStore((s) => s.closeReview)
  const convoId = useAppStore((s) => (s.view.kind === 'conversation' ? s.view.id : null))
  const requestId = convoId ? `${convoId}:${path}` : null
  const [fileLoad, setFileLoad] = useState({
    requestId: null as string | null,
    content: null as string | null,
    failed: false
  })
  const content = fileLoad.requestId === requestId ? fileLoad.content : null
  const failed = fileLoad.requestId === requestId && fileLoad.failed

  useEffect(() => {
    if (!convoId || !requestId) return undefined
    let stale = false
    void window.bearcode.shell
      .readFile(convoId, path)
      .then((text) => {
        if (!stale) setFileLoad({ requestId, content: text, failed: false })
      })
      .catch(() => {
        if (!stale) setFileLoad({ requestId, content: null, failed: true })
      })
    return () => {
      stale = true
    }
  }, [convoId, path, requestId])

  return (
    <>
      <div className="ap-row ap-row-top">
        <ApBrand />
        <span className="ap-file-name">
          {baseName(path)}
          {line ? `:${line}` : ''}
        </span>
        <div className="ap-spacer" />
        <div className="ap-actions">
          <Hint label="Close panel" side="bottom">
            <button aria-label="Close panel" onClick={closeReview}>
              <IconClose />
            </button>
          </Hint>
        </div>
      </div>
      <div className="ap-body">
        {failed ? (
          <div className="diff-loading">
            <EmptyState title="Couldn't open file" hint={path} />
          </div>
        ) : content === null ? (
          <div className="diff-loading">
            <Loading label="Loading file…" />
          </div>
        ) : (
          <Suspense fallback={<Loading />}>
            <MonacoCode
              key={path}
              value={content}
              language={languageForPath(path)}
              revealLine={line}
            />
          </Suspense>
        )}
      </div>
    </>
  )
}
