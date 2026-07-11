import { useEffect, useRef, useState } from 'react'
import type { AppSettings } from '@shared/types'
import { useAppStore } from '../../state/store'
import { IconFilter } from '../icons'
import './DisplayOptions.css'

type GroupBy = AppSettings['sidebarGroupBy']
type Sort = AppSettings['sidebarSort']

const GROUP_OPTIONS: { id: GroupBy; label: string }[] = [
  { id: 'project', label: 'Project' },
  { id: 'environment', label: 'Environment' },
  { id: 'status', label: 'Status' },
  { id: 'none', label: 'None' }
]
const SUBTITLE_OPTIONS: { id: AppSettings['sidebarSubtitle']; label: string }[] = [
  { id: 'none', label: 'No Subtitle' },
  { id: 'worktree', label: 'Worktree' }
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
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const groupBy: GroupBy = settings?.sidebarGroupBy ?? 'project'
  const sort: Sort = settings?.sidebarSort ?? 'updated'
  const subtitle: AppSettings['sidebarSubtitle'] = settings?.sidebarSubtitle ?? 'none'

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

  // Flatten every row across the four groups (group-by, sort, subtitle, the
  // archived-filter toggle) into one navigable list, in render order.
  const flatOptions: { id: string; commit: () => void }[] = [
    ...GROUP_OPTIONS.map((o) => ({
      id: `group-${o.id}`,
      commit: () => void setSidebarView({ sidebarGroupBy: o.id })
    })),
    ...SORT_OPTIONS.map((o) => ({
      id: `sort-${o.id}`,
      commit: () => void setSidebarView({ sidebarSort: o.id })
    })),
    ...SUBTITLE_OPTIONS.map((o) => ({
      id: `subtitle-${o.id}`,
      commit: () => void setSidebarView({ sidebarSubtitle: o.id })
    })),
    {
      id: 'show-archived',
      commit: () => void setSidebarView({ sidebarShowArchived: !settings?.sidebarShowArchived })
    }
  ]

  useEffect(() => {
    if (!open) return
    const i = flatOptions.findIndex((o) => o.id === `group-${groupBy}`)
    setActiveIndex(i >= 0 ? i : 0)
    menuRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const onMenuKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(flatOptions.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(0, i - 1))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActiveIndex(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActiveIndex(flatOptions.length - 1)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      flatOptions[activeIndex]?.commit()
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div className="display-options" ref={rootRef}>
      <button className="chrome-btn" title="Display options" onClick={() => setOpen((o) => !o)}>
        <IconFilter />
      </button>
      {open ? (
        <div
          className="menu display-menu"
          role="listbox"
          ref={menuRef}
          tabIndex={-1}
          aria-activedescendant={`opt-${flatOptions[activeIndex]?.id}`}
          onKeyDown={onMenuKey}
        >
          <div className="menu-group-label">Group By</div>
          {GROUP_OPTIONS.map((o) => {
            const idx = flatOptions.findIndex((f) => f.id === `group-${o.id}`)
            return (
              <div
                key={o.id}
                id={`opt-group-${o.id}`}
                role="option"
                aria-selected={o.id === groupBy}
                className={
                  'menu-item' +
                  (o.id === groupBy ? ' selected' : '') +
                  (idx === activeIndex ? ' active' : '')
                }
                onClick={() => flatOptions[idx]?.commit()}
                onMouseEnter={() => idx >= 0 && setActiveIndex(idx)}
              >
                <span>{o.label}</span>
                {o.id === groupBy ? <span className="check">✓</span> : null}
              </div>
            )
          })}
          <div className="display-sep" />
          <div className="menu-group-label">Sort Conversations</div>
          {SORT_OPTIONS.map((o) => {
            const idx = flatOptions.findIndex((f) => f.id === `sort-${o.id}`)
            return (
              <div
                key={o.id}
                id={`opt-sort-${o.id}`}
                role="option"
                aria-selected={o.id === sort}
                className={
                  'menu-item' +
                  (o.id === sort ? ' selected' : '') +
                  (idx === activeIndex ? ' active' : '')
                }
                onClick={() => flatOptions[idx]?.commit()}
                onMouseEnter={() => idx >= 0 && setActiveIndex(idx)}
              >
                <span>{o.label}</span>
                {o.id === sort ? <span className="check">✓</span> : null}
              </div>
            )
          })}
          <div className="display-sep" />
          <div className="menu-group-label">Subtitles</div>
          {SUBTITLE_OPTIONS.map((o) => {
            const idx = flatOptions.findIndex((f) => f.id === `subtitle-${o.id}`)
            return (
              <div
                key={o.id}
                id={`opt-subtitle-${o.id}`}
                role="option"
                aria-selected={o.id === subtitle}
                className={
                  'menu-item' +
                  (o.id === subtitle ? ' selected' : '') +
                  (idx === activeIndex ? ' active' : '')
                }
                onClick={() => flatOptions[idx]?.commit()}
                onMouseEnter={() => idx >= 0 && setActiveIndex(idx)}
              >
                <span>{o.label}</span>
                {o.id === subtitle ? <span className="check">✓</span> : null}
              </div>
            )
          })}
          <div className="display-sep" />
          <div className="menu-group-label">Filter</div>
          <div
            id="opt-show-archived"
            role="option"
            aria-selected={!!settings?.sidebarShowArchived}
            className={
              'menu-item' +
              (settings?.sidebarShowArchived ? ' selected' : '') +
              (flatOptions[activeIndex]?.id === 'show-archived' ? ' active' : '')
            }
            onClick={() => flatOptions.find((f) => f.id === 'show-archived')?.commit()}
            onMouseEnter={() => {
              const idx = flatOptions.findIndex((f) => f.id === 'show-archived')
              if (idx >= 0) setActiveIndex(idx)
            }}
          >
            <span>Show archived</span>
            {settings?.sidebarShowArchived ? <span className="check">✓</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
