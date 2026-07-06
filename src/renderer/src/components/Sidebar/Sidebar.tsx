import { useAppStore } from '../../state/store'
import { relativeAge } from '../../lib/time'
import bearMark from '../../assets/bear.svg'
import { Hint } from '../Hint'
import { groupConversations } from './grouping'
import { DisplayOptions } from './DisplayOptions'
import {
  IconClock,
  IconClose,
  IconFolder,
  IconFolderPlus,
  IconHistory,
  IconPanel,
  IconPlus,
  IconSearch,
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
  const deleteConvo = useAppStore((s) => s.deleteConvo)
  const openSettings = useAppStore((s) => s.openSettings)
  const openSearch = useAppStore((s) => s.openSearch)
  const showToast = useAppStore((s) => s.showToast)
  const projects = useAppStore((s) => s.projects)
  const createProject = useAppStore((s) => s.createProject)
  const assignConversationProject = useAppStore((s) => s.assignConversationProject)
  const groupBy = useAppStore((s) => s.settings?.sidebarGroupBy ?? 'project')
  const sort = useAppStore((s) => s.settings?.sidebarSort ?? 'updated')

  const groups = groupConversations(convoOrder, conversations, projects, { groupBy, sort })

  return (
    <div className={'sidebar' + (collapsed ? ' collapsed' : '')}>
      <div className="chrome">
        <Hint label="Toggle Sidebar" keys="⌘B" side="bottom">
          <button className="chrome-btn" onClick={toggleSidebar}>
            <IconPanel />
          </button>
        </Hint>
        <Hint label="Search" keys="⌘K" side="bottom">
          <button className="chrome-btn" onClick={openSearch}>
            <IconSearch />
          </button>
        </Hint>
        <span className="wordmark">
          <img src={bearMark} alt="" />
          BearCode
        </span>
      </div>

      <Hint label="New Conversation" keys="⌘N" side="right">
        <button className={'nav-item' + (view.kind === 'home' ? ' selected' : '')} onClick={goHome}>
          <IconPlus />
          New Conversation
        </button>
      </Hint>
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
          <DisplayOptions />
          <button
            className="chrome-btn"
            title="New project"
            onClick={() => {
              const name = window.prompt('Project name')?.trim()
              if (name) void createProject(name)
            }}
          >
            <IconFolderPlus />
          </button>
        </div>
      </div>

      <div className="projects-scroll">
        {groups.length === 0 ? <div className="empty-note">No conversations yet</div> : null}
        {groups.map((group) => (
          <div
            className="proj-group"
            key={
              group.kind === 'project'
                ? group.projectId
                : group.kind === 'all'
                  ? 'all'
                  : 'folder:' + group.label
            }
          >
            {group.kind !== 'all' ? (
              <div className="proj-label">
                <IconFolder />
                <span>{group.label}</span>
              </div>
            ) : null}
            {group.convoIds.map((id) => {
              const convo = conversations[id]
              if (!convo) return null
              const running = convo.runState === 'running' || convo.runState === 'awaiting-approval'
              const selected = view.kind === 'conversation' && view.id === id
              return (
                <div
                  key={id}
                  className={'convo' + (running ? ' active-run' : '') + (selected ? ' selected' : '')}
                  onClick={() => openConvo(id)}
                >
                  <span className="name">{convo.title}</span>
                  {running ? (
                    <span className="dot" />
                  ) : (
                    <>
                      <span className="age">{relativeAge(convo.updatedAt)}</span>
                      <select
                        className="move-proj"
                        title="Move to project"
                        value={convo.projectId ?? ''}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          e.stopPropagation()
                          assignConversationProject(id, e.target.value === '' ? null : e.target.value)
                        }}
                      >
                        <option value="">No project</option>
                        {projects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                      <button
                        className="del"
                        title="Delete conversation"
                        onClick={(e) => {
                          e.stopPropagation()
                          if (window.confirm(`Delete "${convo.title}"?`)) deleteConvo(id)
                        }}
                      >
                        <IconClose size={12} />
                      </button>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </div>

      <div className="sidebar-footer">
        <Hint label="Open Settings" keys="⌘," side="right">
          <button className="nav-item" onClick={openSettings}>
            <IconSettings />
            Settings
          </button>
        </Hint>
      </div>
    </div>
  )
}
