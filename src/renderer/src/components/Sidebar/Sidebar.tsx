import { useAppStore } from '../../state/store'
import bearMark from '../../assets/bear.svg'
import {
  IconChevronLeft,
  IconChevronRight,
  IconClock,
  IconFilter,
  IconFolder,
  IconFolderPlus,
  IconHistory,
  IconPanel,
  IconPlus,
  IconSettings
} from '../icons'
import './Sidebar.css'

export function Sidebar(): React.JSX.Element {
  const collapsed = useAppStore((s) => s.sidebarCollapsed)
  const view = useAppStore((s) => s.view)
  const convoOrder = useAppStore((s) => s.convoOrder)
  const conversations = useAppStore((s) => s.conversations)
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const goHome = useAppStore((s) => s.goHome)
  const openScheduled = useAppStore((s) => s.openScheduled)
  const openConvo = useAppStore((s) => s.openConvo)
  const openSettings = useAppStore((s) => s.openSettings)
  const showToast = useAppStore((s) => s.showToast)

  // Conversations grouped by project, keeping creation order within groups.
  const groups: { label: string; convoIds: string[] }[] = []
  for (const id of convoOrder) {
    const convo = conversations[id]
    if (!convo) continue
    const group = groups.find((g) => g.label === convo.projectLabel)
    if (group) group.convoIds.push(id)
    else groups.push({ label: convo.projectLabel, convoIds: [id] })
  }

  return (
    <div className={'sidebar' + (collapsed ? ' collapsed' : '')}>
      <div className="chrome">
        <button className="chrome-btn" title="Hide sidebar" onClick={toggleSidebar}>
          <IconPanel />
        </button>
        <button className="chrome-btn" disabled title="Back">
          <IconChevronLeft />
        </button>
        <button className="chrome-btn" disabled title="Forward">
          <IconChevronRight />
        </button>
        <span className="wordmark">
          <img src={bearMark} alt="" />
          BearCode
        </span>
      </div>

      <button className={'nav-item' + (view.kind === 'home' ? ' selected' : '')} onClick={goHome}>
        <IconPlus />
        New Conversation
      </button>
      <button className="nav-item" onClick={() => showToast('Conversation history is coming soon')}>
        <IconHistory />
        Conversation History
      </button>
      <button
        className={'nav-item' + (view.kind === 'scheduled' ? ' selected' : '')}
        onClick={openScheduled}
      >
        <IconClock />
        Scheduled Tasks
      </button>

      <div className="projects-head">
        Projects
        <div className="actions">
          <button className="chrome-btn" title="Filter">
            <IconFilter />
          </button>
          <button className="chrome-btn" title="New project" onClick={goHome}>
            <IconFolderPlus />
          </button>
        </div>
      </div>

      <div className="projects-scroll">
        {groups.length === 0 ? <div className="empty-note">No conversations yet</div> : null}
        {groups.map((group) => (
          <div className="proj-group" key={group.label}>
            <div className="proj-label">
              <IconFolder />
              <span>{group.label}</span>
            </div>
            {group.convoIds.map((id) => {
              const convo = conversations[id]
              const running = convo.runState === 'running' || convo.runState === 'awaiting-approval'
              const selected = view.kind === 'conversation' && view.id === id
              return (
                <div
                  key={id}
                  className={
                    'convo' + (running ? ' active-run' : '') + (selected ? ' selected' : '')
                  }
                  onClick={() => openConvo(id)}
                >
                  <span className="name">{convo.title}</span>
                  {running ? <span className="dot" /> : null}
                </div>
              )
            })}
          </div>
        ))}
      </div>

      <div className="sidebar-footer">
        <button className="nav-item" onClick={openSettings}>
          <IconSettings />
          Settings
        </button>
      </div>
    </div>
  )
}
