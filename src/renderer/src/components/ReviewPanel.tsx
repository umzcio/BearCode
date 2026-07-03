import { Suspense, lazy, useEffect, useState } from 'react'
import type { FileDiff } from '@shared/types'
import { useAppStore } from '../state/store'
import { IconClose, IconFile } from './icons'
import './ReviewPanel.css'

const MonacoDiff = lazy(() => import('./MonacoDiff'))

const LANG_BY_EXT: Record<string, string> = {
  html: 'html',
  htm: 'html',
  css: 'css',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  md: 'markdown',
  py: 'python',
  sh: 'shell',
  zsh: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql',
  xml: 'xml'
}

function languageFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return LANG_BY_EXT[ext] ?? 'plaintext'
}

export function ReviewPanel(): React.JSX.Element | null {
  const diffId = useAppStore((s) => s.reviewDiffId)
  if (!diffId) return null
  // Keyed on diffId so per-diff state starts fresh each time it opens.
  return <ReviewPanelInner key={diffId} diffId={diffId} />
}

function ReviewPanelInner({ diffId }: { diffId: string }): React.JSX.Element {
  const closeReview = useAppStore((s) => s.closeReview)
  const showToast = useAppStore((s) => s.showToast)
  const [diff, setDiff] = useState<FileDiff | null>(null)
  const [fileIndex, setFileIndex] = useState(0)

  useEffect(() => {
    let stale = false
    void window.bearcode.diffs.get(diffId).then((d) => {
      if (!stale) setDiff(d)
    })
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeReview()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      stale = true
      window.removeEventListener('keydown', onKey)
    }
  }, [diffId, closeReview])

  const files = diff?.files ?? []
  const file = files[Math.min(fileIndex, Math.max(0, files.length - 1))]
  const pendingCount = files.filter((f) => f.state === 'pending').length

  const setFileState = (fileId: string, state: 'accepted' | 'rejected'): void => {
    setDiff((d) =>
      d ? { ...d, files: d.files.map((f) => (f.fileId === fileId ? { ...f, state } : f)) } : d
    )
  }

  const resolveFile = async (fileId: string, accept: boolean): Promise<void> => {
    if (accept) await window.bearcode.diffs.accept(fileId)
    else await window.bearcode.diffs.reject(fileId)
    setFileState(fileId, accept ? 'accepted' : 'rejected')
    showToast(accept ? 'Changes accepted' : 'Change rejected')
    if (pendingCount <= 1) closeReview()
  }

  const acceptAll = async (): Promise<void> => {
    for (const f of files) {
      if (f.state === 'pending') await window.bearcode.diffs.accept(f.fileId)
    }
    showToast('All changes accepted')
    closeReview()
  }

  const name = file ? (file.path.split('/').pop() ?? file.path) : ''
  const dir = file ? file.path.slice(0, Math.max(0, file.path.length - name.length - 1)) : ''

  return (
    <div className="review-side">
      <div className="review-side-head">
        <IconFile />
        <span className="review-side-title">Review</span>
        <button className="close" title="Close" onClick={closeReview}>
          <IconClose />
        </button>
      </div>

      {file ? (
        <div className="review-file-head">
          <span className="ftype">{file.status === 'created' ? 'M+' : 'M'}</span>
          <span className="fname">{name}</span>
          {dir ? <span className="fpath">{dir}</span> : null}
          <span className="stats">
            <span className="plus">+{file.additions}</span>
            <span className="minus">-{file.deletions}</span>
          </span>
        </div>
      ) : (
        <div className="review-file-head">
          <span className="fpath">Loading changes…</span>
        </div>
      )}

      {files.length > 1 ? (
        <div className="review-file-strip">
          {files.map((f, i) => {
            const fname = f.path.split('/').pop() ?? f.path
            return (
              <button
                key={f.fileId}
                className={'strip-file' + (i === fileIndex ? ' selected' : '')}
                onClick={() => setFileIndex(i)}
              >
                <span className="fname">{fname}</span>
                {f.state === 'pending' ? (
                  <span className="stats">
                    <span className="plus">+{f.additions}</span>
                    <span className="minus">-{f.deletions}</span>
                  </span>
                ) : (
                  <span className={'file-state ' + f.state}>
                    {f.state === 'accepted' ? 'Accepted' : 'Rejected'}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      ) : null}

      <div className="review-side-body">
        {file ? (
          <Suspense fallback={<div className="diff-loading">Loading diff…</div>}>
            <MonacoDiff
              original={file.beforeText}
              modified={file.afterText}
              language={languageFor(file.path)}
            />
          </Suspense>
        ) : (
          <div className="diff-loading">Loading changes…</div>
        )}
      </div>

      <div className="review-side-foot">
        {file && file.state !== 'pending' ? (
          <span className={'file-state ' + file.state}>
            {file.state === 'accepted' ? 'Accepted' : 'Rejected'}
          </span>
        ) : null}
        {files.length > 1 && pendingCount > 1 ? (
          <button className="foot-btn accept" onClick={() => void acceptAll()}>
            Accept all
          </button>
        ) : null}
        {file && file.state === 'pending' ? (
          <>
            <button className="foot-btn" onClick={() => void resolveFile(file.fileId, false)}>
              Reject
            </button>
            <button className="foot-btn accept" onClick={() => void resolveFile(file.fileId, true)}>
              Accept changes
            </button>
          </>
        ) : null}
      </div>
    </div>
  )
}
