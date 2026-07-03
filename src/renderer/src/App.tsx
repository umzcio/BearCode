import { useEffect } from 'react'
import { Sidebar } from './components/Sidebar/Sidebar'
import { Home } from './components/Home'
import { ConversationView } from './components/ConversationView'
import { ReviewModal } from './components/ReviewModal'
import { SettingsModal } from './components/Settings/SettingsModal'
import { RoarBear } from './components/brand/RoarBear'
import { Hint } from './components/Hint'
import { IconPanel } from './components/icons'
import { useAppStore } from './state/store'
import './App.css'

function ScheduledView(): React.JSX.Element {
  return (
    <div className="empty-state">
      <RoarBear scale={4} />
      <div className="empty-title">Scheduled tasks are coming soon</div>
      <div className="empty-sub">Saved prompts on a schedule, run by ursa while you sleep.</div>
    </div>
  )
}

function App(): React.JSX.Element {
  const collapsed = useAppStore((s) => s.sidebarCollapsed)
  const view = useAppStore((s) => s.view)
  const conversations = useAppStore((s) => s.conversations)
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const toast = useAppStore((s) => s.toast)
  const init = useAppStore((s) => s.init)

  useEffect(() => {
    init()
  }, [init])

  // Global shortcuts: Cmd+N new conversation, Cmd+B sidebar, Cmd+, settings,
  // Cmd+/ model menu, Cmd+L focus the composer.
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
    <div className="app">
      <Sidebar />
      <div className={'main' + (collapsed ? ' sidebar-collapsed' : '')}>
        <div className="topbar">
          {collapsed ? (
            <Hint label="Toggle Sidebar" keys="⌘B" side="bottom">
              <button className="chrome-btn" onClick={toggleSidebar}>
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
        {view.kind === 'home' ? <Home /> : null}
        {view.kind === 'scheduled' ? <ScheduledView /> : null}
        {convo ? <ConversationView key={convo.id} convoId={convo.id} /> : null}
        <ReviewModal />
        <SettingsModal />
      </div>
      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  )
}

export default App
