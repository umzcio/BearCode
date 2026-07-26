import { useRef, useState } from 'react'
import { useAppStore } from '../../state/store'
import { Popover } from '../ui/Popover'
import { Hint } from '../Hint'
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
  // The quick toggle can only flip between 'dark' and 'light'. For 'system'
  // (follow OS) or 'custom' (saved palette), there's no single-click binary
  // flip that makes sense -- so this control disables its theme-mutating
  // click path and instead defers to the full Settings > Appearance picker,
  // which already offers all four modes.
  const isBinary = theme === 'dark' || theme === 'light'

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
          <Hint
            label={
              isBinary ? 'Toggle dark mode' : 'Following System/Custom — manage in Settings'
            }
            side="bottom"
          >
            <button
              type="button"
              role={isBinary ? 'menuitemcheckbox' : 'menuitem'}
              aria-checked={isBinary ? isDark : undefined}
              aria-label={
                isBinary ? 'Dark Mode' : 'Dark Mode — following System/Custom, manage in Settings'
              }
              className={'menu-item' + (isDark ? ' selected' : '') + (!isBinary ? ' redirect' : '')}
              onClick={() => {
                if (!isBinary) {
                  setOpen(false)
                  openSettings()
                  return
                }
                void setAppearance({ theme: isDark ? 'light' : 'dark' })
              }}
            >
              <IconMoon />
              <span>Dark Mode</span>
              <span className="check">✓</span>
            </button>
          </Hint>
        </div>
      </Popover>
    </div>
  )
}
