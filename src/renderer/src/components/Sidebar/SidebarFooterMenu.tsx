import { useRef, useState } from 'react'
import { useAppStore } from '../../state/store'
import { Popover } from '../ui/Popover'
import { IconChevronDown, IconMoon, IconSettings } from '../icons'
import './SidebarFooterMenu.css'

export function SidebarFooterMenu(): React.JSX.Element {
  const profileName = useAppStore((s) => s.settings?.profileName)
  const theme = useAppStore((s) => s.settings?.theme ?? 'dark')
  const openSettings = useAppStore((s) => s.openSettings)
  const setAppearance = useAppStore((s) => s.setAppearance)
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const isDark = theme === 'dark'

  return (
    <div className="sb-footer">
      <button
        ref={triggerRef}
        type="button"
        className="sb-name-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="name">{profileName || 'You'}</span>
        <IconChevronDown />
      </button>
      <Popover
        anchorRef={triggerRef}
        open={open}
        onClose={() => setOpen(false)}
        placement="top-start"
      >
        <div className="menu menu--in-popover acct-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setOpen(false)
              openSettings()
            }}
          >
            <IconSettings />
            <span>Settings</span>
          </button>
          <div className="menu-divider" />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={isDark}
            aria-label="Dark Mode"
            className={'menu-item' + (isDark ? ' selected' : '')}
            onClick={() => void setAppearance({ theme: isDark ? 'light' : 'dark' })}
          >
            <IconMoon />
            <span>Dark Mode</span>
            <span className="check">✓</span>
          </button>
        </div>
      </Popover>
    </div>
  )
}
