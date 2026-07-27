import { useAppStore } from '../../state/store'
import { Hint } from '../Hint'
import { IconPanel, IconSearch } from '../icons'
import './WindowChromeControls.css'

export function WindowChromeControls(): React.JSX.Element {
  const collapsed = useAppStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const openHistory = useAppStore((s) => s.openHistory)

  return (
    <div className="window-chrome-controls">
      <Hint label="Toggle Sidebar" keys="⌘B" side="bottom">
        <button className="chrome-btn" onClick={toggleSidebar} aria-label="Toggle sidebar">
          <IconPanel />
        </button>
      </Hint>
      {!collapsed ? (
        <Hint label="Conversation History" keys="⌘K" side="bottom">
          <button className="chrome-btn" onClick={openHistory} aria-label="History">
            <IconSearch />
          </button>
        </Hint>
      ) : null}
    </div>
  )
}
