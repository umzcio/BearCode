import { useEffect, useRef, useState } from 'react'
import type { AppSettings } from '@shared/types'
import { useAppStore } from '../../state/store'
import { IconFilter } from '../icons'
import './DisplayOptions.css'

type GroupBy = AppSettings['sidebarGroupBy']
type Sort = AppSettings['sidebarSort']

const GROUP_OPTIONS: { id: GroupBy | 'environment' | 'status'; label: string; enabled: boolean }[] = [
  { id: 'project', label: 'Project', enabled: true },
  { id: 'environment', label: 'Environment', enabled: false },
  { id: 'status', label: 'Status', enabled: false },
  { id: 'none', label: 'None', enabled: true }
]
const SORT_OPTIONS: { id: Sort; label: string }[] = [
  { id: 'updated', label: 'Last Updated' },
  { id: 'alpha', label: 'Alphabetical (A–Z)' },
  { id: 'created', label: 'Date Added' }
]

export function DisplayOptions(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const setSidebarView = useAppStore((s) => s.setSidebarView)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const groupBy: GroupBy = settings?.sidebarGroupBy ?? 'project'
  const sort: Sort = settings?.sidebarSort ?? 'updated'

  useEffect(() => {
    if (!open) return undefined
    const close = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('click', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="display-options" ref={rootRef}>
      <button className="chrome-btn" title="Display options" onClick={() => setOpen((o) => !o)}>
        <IconFilter />
      </button>
      {open ? (
        <div className="menu display-menu">
          <div className="menu-group-label">Group By</div>
          {GROUP_OPTIONS.map((o) => (
            <div
              key={o.id}
              className={'menu-item' + (o.enabled ? '' : ' disabled') + (o.enabled && o.id === groupBy ? ' selected' : '')}
              onClick={() => {
                if (o.enabled) void setSidebarView({ sidebarGroupBy: o.id as GroupBy })
              }}
            >
              <span>{o.label}</span>
              {!o.enabled ? <span className="badge">coming soon</span> : o.id === groupBy ? <span className="check">✓</span> : null}
            </div>
          ))}
          <div className="display-sep" />
          <div className="menu-group-label">Sort Conversations</div>
          {SORT_OPTIONS.map((o) => (
            <div
              key={o.id}
              className={'menu-item' + (o.id === sort ? ' selected' : '')}
              onClick={() => void setSidebarView({ sidebarSort: o.id })}
            >
              <span>{o.label}</span>
              {o.id === sort ? <span className="check">✓</span> : null}
            </div>
          ))}
          <div className="display-sep" />
          <div className="menu-group-label">Subtitles</div>
          <div className="menu-item selected">
            <span>No Subtitle</span>
            <span className="check">✓</span>
          </div>
          <div className="menu-item disabled">
            <span>Worktree</span>
            <span className="badge">coming soon</span>
          </div>
          <div className="display-sep" />
          <div className="menu-group-label">Filter</div>
          <div
            className={'menu-item' + (settings?.sidebarShowArchived ? ' selected' : '')}
            onClick={() => void setSidebarView({ sidebarShowArchived: !settings?.sidebarShowArchived })}
          >
            <span>Show archived</span>
            {settings?.sidebarShowArchived ? <span className="check">✓</span> : null}
          </div>
          <div className="menu-item disabled">
            <span>Scheduled</span>
            <span className="badge">coming soon</span>
          </div>
        </div>
      ) : null}
    </div>
  )
}
