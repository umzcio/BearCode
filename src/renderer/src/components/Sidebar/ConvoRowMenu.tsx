import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../state/store'
import { IconDots } from '../icons'
import './ConvoRowMenu.css'

export function ConvoRowMenu({
  convoId,
  title,
  projectId
}: {
  convoId: string
  title: string
  projectId: string | null
}): React.JSX.Element {
  const projects = useAppStore((s) => s.projects)
  const renameConversation = useAppStore((s) => s.renameConversation)
  const assignConversationProject = useAppStore((s) => s.assignConversationProject)
  const deleteConvo = useAppStore((s) => s.deleteConvo)
  const [open, setOpen] = useState(false)
  // Fixed-position coords measured off the ⋮ button so the menu snaps directly
  // under it and floats OVER the content (the sidebar's scroll container would
  // otherwise clip/offset an absolutely-positioned popover — the "not snapped"
  // feel). Recomputed each open.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return undefined
    const close = (e: MouseEvent): void => {
      // The menu is a DOM descendant of rootRef even while position:fixed, so
      // contains() still correctly treats menu clicks as inside.
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    // A fixed menu can't follow the sidebar scroll — close on any scroll.
    const onScroll = (): void => setOpen(false)
    document.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  const stop = (e: React.MouseEvent): void => e.stopPropagation()

  const toggle = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect()
      setPos({ top: r.bottom + 4, left: r.left })
    }
    setOpen((o) => !o)
  }

  return (
    <div className="convo-menu" ref={rootRef} onClick={stop}>
      <button ref={btnRef} className="row-act" title="More" onClick={toggle}>
        <IconDots size={14} />
      </button>
      {open ? (
        <div
          className="menu convo-menu-pop"
          style={pos ? { position: 'fixed', top: pos.top, left: pos.left } : undefined}
        >
          <div
            className="menu-item"
            onClick={() => {
              setOpen(false)
              const next = window.prompt('Rename conversation', title)?.trim()
              if (next) renameConversation(convoId, next)
            }}
          >
            Rename
          </div>
          <div
            className="menu-item danger"
            onClick={() => {
              setOpen(false)
              if (window.confirm(`Delete "${title}"?`)) deleteConvo(convoId)
            }}
          >
            Delete Conversation
          </div>
          <div className="convo-menu-sep" />
          <div className="menu-group-label">Move to project</div>
          <div
            className={'menu-item' + (projectId === null ? ' selected' : '')}
            onClick={() => {
              setOpen(false)
              assignConversationProject(convoId, null)
            }}
          >
            No project
            {projectId === null ? <span className="check">✓</span> : null}
          </div>
          {projects.map((p) => (
            <div
              key={p.id}
              className={'menu-item' + (projectId === p.id ? ' selected' : '')}
              onClick={() => {
                setOpen(false)
                assignConversationProject(convoId, p.id)
              }}
            >
              {p.name}
              {projectId === p.id ? <span className="check">✓</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
