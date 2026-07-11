import { memo, useState } from 'react'
import type { Event } from '@shared/types'
import { useAppStore } from '../../state/store'
import { useCmdHeld } from '../../lib/useCmdHeld'
import { IconChevronDown, IconFile } from '../icons'
import './events.css'

type FileDiffEvent = Extract<Event, { type: 'file_diff' }>

function DiffCardImpl({ event }: { event: FileDiffEvent }): React.JSX.Element {
  const [closed, setClosed] = useState(false)
  const openReview = useAppStore((s) => s.openReview)
  const openFile = useAppStore((s) => s.openFile)
  const cmdHeld = useCmdHeld()
  const files = event.files
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
        <button className="review-btn" onClick={() => openReview(event.diffId)}>
          <IconFile />
          Review
        </button>
      </div>
      <div className="diff-files">
        {files.map((file) => {
          const name = file.path.split('/').pop() ?? file.path
          const dir = file.path.slice(0, Math.max(0, file.path.length - name.length - 1))
          return (
            <div
              className={'diff-file' + (cmdHeld ? ' cmd-openable' : '')}
              key={file.path}
              title={cmdHeld ? 'Cmd-click to open' : undefined}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey) {
                  e.stopPropagation()
                  openFile(file.path)
                } else {
                  openReview(event.diffId)
                }
              }}
            >
              <span className="ftype">{file.status === 'created' ? 'M+' : 'M'}</span>
              <span className="fname">{name}</span>
              <span className="fpath">{dir}</span>
              <span className="stats">
                <span className="plus">+{file.additions}</span>
                <span className="minus">-{file.deletions}</span>
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
export const DiffCard = memo(DiffCardImpl)
