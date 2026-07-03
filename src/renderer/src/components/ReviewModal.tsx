import { Suspense, lazy, useEffect, useState } from 'react'
import { DEMO_DIFF } from '../demo/data'
import { useAppStore } from '../state/store'
import { IconClose } from './icons'
import './ReviewModal.css'

const MonacoDiff = lazy(() => import('./MonacoDiff'))

export function ReviewModal(): React.JSX.Element | null {
  const diffId = useAppStore((s) => s.reviewDiffId)
  const closeReview = useAppStore((s) => s.closeReview)
  const showToast = useAppStore((s) => s.showToast)
  const [fileIndex, setFileIndex] = useState(0)

  useEffect(() => {
    if (!diffId) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setFileIndex(0)
        closeReview()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [diffId, closeReview])

  if (!diffId) return null
  const files = DEMO_DIFF[diffId] ?? []
  const file = files[Math.min(fileIndex, files.length - 1)]
  if (!file) return null

  const close = (): void => {
    setFileIndex(0)
    closeReview()
  }

  return (
    <div className="modal-overlay open" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="review-panel">
        <div className="review-head">
          <span className="ftype">{file.status === 'created' ? 'M+' : 'M'}</span>
          <span className="fname">{file.name}</span>
          <span className="fpath">{file.path}</span>
          <span className="stats">
            <span className="plus">+{file.additions}</span>
            <span className="minus">-{file.deletions}</span>
          </span>
          <button className="close" title="Close" onClick={close}>
            <IconClose />
          </button>
        </div>
        <div className="review-body">
          {files.length > 1 ? (
            <div className="review-rail">
              {files.map((f, i) => (
                <div
                  key={f.path + f.name}
                  className={'rail-file' + (i === fileIndex ? ' selected' : '')}
                  onClick={() => setFileIndex(i)}
                >
                  <span className="fname">{f.name}</span>
                  <span className="stats">
                    <span className="plus">+{f.additions}</span>
                    <span className="minus">-{f.deletions}</span>
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          <Suspense fallback={<div className="diff-loading">Loading diff…</div>}>
            <MonacoDiff original={file.before} modified={file.after} />
          </Suspense>
        </div>
        <div className="review-foot">
          <button
            className="foot-btn"
            onClick={() => {
              showToast('Change rejected')
              close()
            }}
          >
            Reject
          </button>
          <button
            className="foot-btn accept"
            onClick={() => {
              showToast('Changes accepted')
              close()
            }}
          >
            Accept changes
          </button>
        </div>
      </div>
    </div>
  )
}
