import { useEffect } from 'react'
import { Sidebar } from './components/Sidebar/Sidebar'
import { Home } from './components/Home'
import { HistoryView } from './components/History/HistoryView'
import { ConversationView } from './components/ConversationView'
import { AuxiliaryPane } from './components/AuxiliaryPane'
import { ResizeHandle } from './components/ResizeHandle'
import { SettingsModal } from './components/Settings/SettingsModal'
import { ProjectSettingsModal } from './components/ProjectSettings/ProjectSettingsModal'
import { ConflictResolver } from './components/Worktree/ConflictResolver'
import { Hint } from './components/Hint'
import { IconPanel } from './components/icons'
import { TrustBanner } from './components/TrustBanner'
import { OutsideAccessCard } from './components/OutsideAccessCard'
import { useAppStore } from './state/store'
import { useCmdHeld } from './lib/useCmdHeld'
import './App.css'

function App(): React.JSX.Element {
  const collapsed = useAppStore((s) => s.sidebarCollapsed)
  const view = useAppStore((s) => s.view)
  const conversations = useAppStore((s) => s.conversations)
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const auxSelection = useAppStore((s) => s.auxSelection)
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth)
  const setAuxPaneWidth = useAppStore((s) => s.setAuxPaneWidth)
  const toast = useAppStore((s) => s.toast)
  const dismissToast = useAppStore((s) => s.dismissToast)
  const init = useAppStore((s) => s.init)
  const cmdHeld = useCmdHeld()

  useEffect(() => {
    init()
  }, [init])

  // Responsive collapse (Claude-Code / Antigravity style): auto-collapse the
  // left nav on a narrow window so the conversation + composer aren't squished.
  // Edge-triggered on crossing the breakpoint, so a manual toggle still sticks
  // within a size regime.
  useEffect(() => {
    const BP = 820
    let prevNarrow = window.innerWidth < BP
    if (prevNarrow && !useAppStore.getState().sidebarCollapsed) {
      useAppStore.getState().setSidebarCollapsed(true)
    }
    const onResize = (): void => {
      const narrow = window.innerWidth < BP
      if (narrow === prevNarrow) return
      prevNarrow = narrow
      useAppStore.getState().setSidebarCollapsed(narrow)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Global shortcuts: Cmd+N new conversation, Cmd+B sidebar, Cmd+, settings,
  // Cmd+/ model menu, Cmd+. mode menu, Cmd+L focus the composer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      const s = useAppStore.getState()
      switch (e.key) {
        case 'n':
          e.preventDefault()
          s.goHome()
          break
        case 'b':
          e.preventDefault()
          s.toggleSidebar()
          break
        case ',':
          e.preventDefault()
          s.openSettings()
          break
        case '/':
          e.preventDefault()
          s.toggleModelMenu()
          break
        case '.':
          e.preventDefault()
          s.togglePermMenu()
          break
        case ';':
          e.preventDefault()
          s.toggleProjectMenu()
          break
        case 'k':
          e.preventDefault()
          s.openHistory()
          break
        case 'l': {
          e.preventDefault()
          const ta = document.querySelector<HTMLTextAreaElement>('.composer textarea')
          ta?.focus()
          break
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const convo = view.kind === 'conversation' ? conversations[view.id] : null

  return (
    <div className={'app' + (cmdHeld ? ' cmd-held' : '')}>
      <Sidebar />
      {!collapsed ? (
        <ResizeHandle onDrag={(dx) => setSidebarWidth(useAppStore.getState().sidebarWidth + dx)} />
      ) : null}
      <div className={'main' + (collapsed ? ' sidebar-collapsed' : '')}>
        <div className="topbar">
          {collapsed ? (
            <Hint label="Toggle Sidebar" keys="⌘B" side="bottom">
              <button className="chrome-btn" onClick={toggleSidebar} aria-label="Toggle sidebar">
                <IconPanel />
              </button>
            </Hint>
          ) : null}
          {convo ? (
            <div className="breadcrumb">
              <span className="crumb">{convo.projectLabel}</span>
              <span className="sep">/</span>
              <span className="crumb current">{convo.title}</span>
            </div>
          ) : null}
        </div>
        <TrustBanner />
        <OutsideAccessCard />
        {view.kind === 'home' ? <Home /> : null}
        {view.kind === 'history' ? <HistoryView /> : null}
        {convo ? <ConversationView key={convo.id} convoId={convo.id} /> : null}
        <SettingsModal />
        <ProjectSettingsModal />
        <ConflictResolver />
      </div>
      {auxSelection ? (
        <ResizeHandle onDrag={(dx) => setAuxPaneWidth(useAppStore.getState().auxPaneWidth - dx)} />
      ) : null}
      <AuxiliaryPane />
      {toast ? (
        <div className="toast" role="status" aria-live="polite">
          <span className="toast-msg">{toast.message}</span>
          {toast.action ? (
            <span className="toast-actions">
              <button className="toast-btn" onClick={dismissToast}>
                Dismiss
              </button>
              <button
                className="toast-btn primary"
                onClick={() => {
                  toast.action?.run()
                  dismissToast()
                }}
              >
                {toast.action.label}
              </button>
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export default App
