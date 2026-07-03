import { Sidebar } from './components/Sidebar/Sidebar'
import { Home } from './components/Home'
import { ConversationView } from './components/ConversationView'
import { ReviewModal } from './components/ReviewModal'
import { RoarBear } from './components/brand/RoarBear'
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

  const convo = view.kind === 'conversation' ? conversations[view.id] : null

  return (
    <div className="app">
      <Sidebar />
      <div className={'main' + (collapsed ? ' sidebar-collapsed' : '')}>
        <div className="topbar">
          {collapsed ? (
            <button className="chrome-btn" title="Show sidebar" onClick={toggleSidebar}>
              <IconPanel />
            </button>
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
      </div>
      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  )
}

export default App
