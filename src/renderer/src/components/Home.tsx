import { useEffect, useRef, useState } from 'react'
import { Composer } from './Composer/Composer'
import { PixelBear } from './brand/PixelBear'
import { useAppStore } from '../state/store'
import { Hint } from './Hint'
import { IconChevronDown, IconFolder, IconFolderPlus } from './icons'
import { Menu, type MenuGroup } from './ui/Menu'
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
  const triggerRef = useRef<HTMLButtonElement>(null)
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

  const choose = (path: string | null): void => {
    setWorkspace(path)
    setOpen(false)
  }

  const projectGroups: MenuGroup[] = []
  if (recents.length > 0) {
    projectGroups.push({
      items: recents.map((path) => ({
        value: path,
        label: shorten(path),
        icon: <IconFolder />
      }))
    })
  }
  projectGroups.push({
    items: [{ value: '__open__', label: 'Open a folder…', icon: <IconFolderPlus /> }]
  })
  projectGroups.push({
    items: [{ value: '__none__', label: 'No folder', icon: <IconFolder /> }]
  })

  const handleProjectSelect = (v: string): void => {
    if (v === '__open__') {
      setOpen(false)
      void pickWorkspace()
    } else if (v === '__none__') {
      choose(null)
    } else {
      choose(v)
    }
  }

  return (
    <div className="home">
      <div className="composer-wrap">
        <div className="project-picker">
          <Hint label="Select Folder" keys="⌘;" side="top" disabled={open}>
            <button
              type="button"
              ref={triggerRef}
              className="workspace-row"
              onClick={() => setOpen((o) => !o)}
            >
              <IconFolder />
              <span>{workspacePath ? shorten(workspacePath) : 'Choose a folder'}</span>
              <span className="workspace-chev">
                <IconChevronDown />
              </span>
            </button>
          </Hint>
          <Menu
            anchorRef={triggerRef}
            open={open}
            onClose={() => setOpen(false)}
            groups={projectGroups}
            value={workspacePath ?? undefined}
            onSelect={handleProjectSelect}
            placement="bottom-start"
            ariaLabel="Choose a folder"
          />
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
