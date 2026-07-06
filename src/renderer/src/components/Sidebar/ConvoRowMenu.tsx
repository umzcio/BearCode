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
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return undefined
    const close = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const stop = (e: React.MouseEvent): void => e.stopPropagation()

  return (
    <div className="convo-menu" ref={rootRef} onClick={stop}>
      <button className="row-act" title="More" onClick={() => setOpen((o) => !o)}>
        <IconDots size={14} />
      </button>
      {open ? (
        <div className="menu convo-menu-pop">
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
