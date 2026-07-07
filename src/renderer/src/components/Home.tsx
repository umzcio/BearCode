import { useEffect, useRef, useState } from 'react'
import { Composer } from './Composer/Composer'
import { PixelBear } from './brand/PixelBear'
import { useAppStore } from '../state/store'
import { Hint } from './Hint'
import { IconChevronDown, IconFolder, IconFolderPlus } from './icons'
import './Home.css'

function shorten(path: string): string {
  const home = path.replace(/^\/Users\/[^/]+/, '~')
  return home.length > 46 ? '…' + home.slice(-45) : home
}

export function Home(): React.JSX.Element {
  const startFromHome = useAppStore((s) => s.startFromHome)
  const pickWorkspace = useAppStore((s) => s.pickWorkspace)
  const setWorkspace = useAppStore((s) => s.setWorkspace)
  const workspacePath = useAppStore((s) => s.workspacePath)
  const conversations = useAppStore((s) => s.conversations)
  const convoOrder = useAppStore((s) => s.convoOrder)
  const projectMenuTick = useAppStore((s) => s.projectMenuTick)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const lastTick = useRef(projectMenuTick)

  // Recent projects: most recently active first, deduped.
  const recents: string[] = []
  for (const id of convoOrder) {
    const p = conversations[id]?.projectPath
    if (p && !recents.includes(p)) recents.push(p)
    if (recents.length >= 6) break
  }

  useEffect(() => {
    if (lastTick.current === projectMenuTick) return
    lastTick.current = projectMenuTick
    setOpen((o) => !o)
  }, [projectMenuTick])

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

  const choose = (path: string | null): void => {
    setWorkspace(path)
    setOpen(false)
  }

  return (
    <div className="home">
      <div className="composer-wrap">
        <div className="project-picker" ref={rootRef}>
          <Hint label="Select Project" keys="⌘;" side="top" disabled={open}>
            <div className="workspace-row" onClick={() => setOpen((o) => !o)}>
              <IconFolder />
              <span>{workspacePath ? shorten(workspacePath) : 'Choose a folder'}</span>
              <span className="workspace-chev">
                <IconChevronDown />
              </span>
            </div>
          </Hint>
          {open ? (
            <div className="menu project-menu">
              {recents.map((path) => (
                <div
                  key={path}
                  className={'menu-item' + (path === workspacePath ? ' selected' : '')}
                  onClick={() => choose(path)}
                >
                  <IconFolder />
                  <span>{shorten(path)}</span>
                  <span className="check">✓</span>
                </div>
              ))}
              {recents.length > 0 ? <div className="menu-divider" /> : null}
              <div
                className="menu-item"
                onClick={() => {
                  setOpen(false)
                  void pickWorkspace()
                }}
              >
                <IconFolderPlus />
                <span>New Project</span>
              </div>
              <div className="menu-divider" />
              <div className="menu-item" onClick={() => choose(null)}>
                <IconFolder />
                <span>No Project</span>
              </div>
            </div>
          ) : null}
        </div>
        <div className="composer-stage">
          <span className="composer-perch" aria-hidden="true">
            <PixelBear scale={3} settle />
          </span>
          <Composer onSend={startFromHome} showEnvRow autoFocus />
        </div>
      </div>
    </div>
  )
}
