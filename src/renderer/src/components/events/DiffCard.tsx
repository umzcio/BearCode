import { useState } from 'react'
import { DEMO_DIFF } from '../../demo/data'
import { useAppStore } from '../../state/store'
import { IconChevronDown, IconFile } from '../icons'
import './events.css'

export function DiffCard({ diffId }: { diffId: string }): React.JSX.Element {
  const [closed, setClosed] = useState(false)
  const openReview = useAppStore((s) => s.openReview)
  const files = DEMO_DIFF[diffId] ?? []
  const additions = files.reduce((n, f) => n + f.additions, 0)
  const deletions = files.reduce((n, f) => n + f.deletions, 0)

  return (
    <div className={'diff-card' + (closed ? ' closed' : '')}>
      <div className="diff-head">
        <span className="summary" onClick={() => setClosed((c) => !c)}>
          {files.length} file{files.length === 1 ? '' : 's'} changed{' '}
          <span className="plus">+{additions}</span>
          <span className="minus">-{deletions}</span>
          <span className="chev">
            <IconChevronDown />
          </span>
        </span>
        <button className="review-btn" onClick={() => openReview(diffId)}>
          <IconFile />
          Review
        </button>
      </div>
      <div className="diff-files">
        {files.map((file) => (
          <div className="diff-file" key={file.path + file.name} onClick={() => openReview(diffId)}>
            <span className="ftype">{file.status === 'created' ? 'M+' : 'M'}</span>
            <span className="fname">{file.name}</span>
            <span className="fpath">{file.path}</span>
            <span className="stats">
              <span className="plus">+{file.additions}</span>
              <span className="minus">-{file.deletions}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
