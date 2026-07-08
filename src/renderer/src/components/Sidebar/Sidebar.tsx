import { useAppStore } from '../../state/store'
import { relativeAge } from '../../lib/time'
import bearMark from '../../assets/bear.svg'
import { Hint } from '../Hint'
import { groupConversations } from './grouping'
import { DisplayOptions } from './DisplayOptions'
import { ConvoRowMenu } from './ConvoRowMenu'
import {
  IconArchive,
  IconClock,
  IconClose,
  IconFolder,
  IconFolderPlus,
  IconHistory,
  IconPanel,
  IconPin,
  IconPlus,
  IconSearch,
  IconSettings
} from '../icons'
import './Sidebar.css'

export function Sidebar(): React.JSX.Element {
  const collapsed = useAppStore((s) => s.sidebarCollapsed)
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const view = useAppStore((s) => s.view)
  const convoOrder = useAppStore((s) => s.convoOrder)
  const conversations = useAppStore((s) => s.conversations)
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const goHome = useAppStore((s) => s.goHome)
  const openScheduled = useAppStore((s) => s.openScheduled)
  const openHistory = useAppStore((s) => s.openHistory)
  const openConvo = useAppStore((s) => s.openConvo)
  const openSettings = useAppStore((s) => s.openSettings)
  const openSearch = useAppStore((s) => s.openSearch)
  const projects = useAppStore((s) => s.projects)
  const createProject = useAppStore((s) => s.createProject)
  const setPinned = useAppStore((s) => s.setPinned)
  const setArchived = useAppStore((s) => s.setArchived)
  const newConversationInProject = useAppStore((s) => s.newConversationInProject)
  const renameProject = useAppStore((s) => s.renameProject)
  const deleteProject = useAppStore((s) => s.deleteProject)
  const groupBy = useAppStore((s) => s.settings?.sidebarGroupBy ?? 'project')
  const sort = useAppStore((s) => s.settings?.sidebarSort ?? 'updated')
  const showArchived = useAppStore((s) => s.settings?.sidebarShowArchived ?? false)

  const groups = groupConversations(convoOrder, conversations, projects, {
    groupBy,
    sort,
    showArchived
  })

  return (
    <div
      className={'sidebar' + (collapsed ? ' collapsed' : '')}
      style={{
        width: sidebarWidth,
        minWidth: sidebarWidth,
        marginLeft: collapsed ? -(sidebarWidth + 1) : undefined
      }}
    >
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
      <button
        className={'nav-item' + (view.kind === 'history' ? ' selected' : '')}
        onClick={openHistory}
      >
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
                {group.kind === 'project' ? (
                  <span className="proj-actions">
                    <button
                      className="row-act"
                      title="New conversation in project"
                      onClick={(e) => {
                        e.stopPropagation()
                        void newConversationInProject(group.projectId)
                      }}
                    >
                      <IconPlus size={13} />
                    </button>
                    <button
                      className="row-act"
                      title="Rename project"
                      onClick={(e) => {
                        e.stopPropagation()
                        const n = window.prompt('Rename project', group.label)?.trim()
                        if (n) void renameProject(group.projectId, n)
                      }}
                    >
                      <IconSettings size={13} />
                    </button>
                    <button
                      className="row-act"
                      title="Delete project"
                      onClick={(e) => {
                        e.stopPropagation()
                        if (
                          window.confirm(`Delete project "${group.label}"? Conversations are kept.`)
                        ) {
                          void deleteProject(group.projectId)
                        }
                      }}
                    >
                      <IconClose size={12} />
                    </button>
                  </span>
                ) : null}
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
                  className={
                    'convo' + (running ? ' active-run' : '') + (selected ? ' selected' : '')
                  }
                  onClick={() => openConvo(id)}
                >
                  {convo.pinned ? <IconPin size={11} /> : null}
                  <span className="name">{convo.title}</span>
                  {running ? (
                    <span className="dot" />
                  ) : (
                    <>
                      <span className="age">{relativeAge(convo.updatedAt)}</span>
                      <ConvoRowMenu convoId={id} title={convo.title} projectId={convo.projectId} />
                      <button
                        className={'row-act' + (convo.pinned ? ' active' : '')}
                        title={convo.pinned ? 'Unpin' : 'Pin'}
                        onClick={(e) => {
                          e.stopPropagation()
                          setPinned(id, !convo.pinned)
                        }}
                      >
                        <IconPin size={13} />
                      </button>
                      <button
                        className={'row-act' + (convo.archived ? ' active' : '')}
                        title={convo.archived ? 'Unarchive' : 'Archive'}
                        onClick={(e) => {
                          e.stopPropagation()
                          setArchived(id, !convo.archived)
                        }}
                      >
                        <IconArchive size={13} />
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
