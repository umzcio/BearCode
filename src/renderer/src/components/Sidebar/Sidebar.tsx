import { useAppStore } from '../../state/store'
import { relativeAge } from '../../lib/time'
import bearMark from '../../assets/bear.svg'
import { Hint } from '../Hint'
import { groupConversations } from './grouping'
import { DisplayOptions } from './DisplayOptions'
import { ConvoRowMenu } from './ConvoRowMenu'
import {
  IconArchive,
  IconHistory,
  IconPanel,
  IconPin,
  IconPlus,
  IconSearch,
  IconSettings
} from '../icons'
import { projectIcon } from '../ProjectSettings/projectIcons'
import './Sidebar.css'

export function Sidebar(): React.JSX.Element {
  const collapsed = useAppStore((s) => s.sidebarCollapsed)
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const view = useAppStore((s) => s.view)
  const convoOrder = useAppStore((s) => s.convoOrder)
  const conversations = useAppStore((s) => s.conversations)
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const goHome = useAppStore((s) => s.goHome)
  const openHistory = useAppStore((s) => s.openHistory)
  const openConvo = useAppStore((s) => s.openConvo)
  const openSettings = useAppStore((s) => s.openSettings)
  const openSearch = useAppStore((s) => s.openSearch)
  const folderSettings = useAppStore((s) => s.folderSettings)
  const setPinned = useAppStore((s) => s.setPinned)
  const setArchived = useAppStore((s) => s.setArchived)
  const newConversationInProject = useAppStore((s) => s.newConversationInProject)
  const openProjectSettings = useAppStore((s) => s.openProjectSettings)
  const groupBy = useAppStore((s) => s.settings?.sidebarGroupBy ?? 'project')
  const sort = useAppStore((s) => s.settings?.sidebarSort ?? 'updated')
  const showArchived = useAppStore((s) => s.settings?.sidebarShowArchived ?? false)

  const groups = groupConversations(convoOrder, conversations, {
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

      <div className="projects-head">
        Projects
        <div className="actions">
          <DisplayOptions />
        </div>
      </div>

      <div className="projects-scroll">
        {groups.length === 0 ? <div className="empty-note">No conversations yet</div> : null}
        {groups.map((group) => {
          // Every folder group is a project keyed by its path; look up its
          // stored color/icon/name (a folder with no row shows the default icon
          // and its basename). "No folder" (path null) has no settings + no gear.
          const path = group.kind === 'folder' ? group.path : null
          const fp = path ? folderSettings.find((f) => f.path === path) : undefined
          const Icon = projectIcon(fp?.icon)
          const label = group.kind === 'folder' ? (fp?.name ?? group.label) : ''
          return (
            <div
              className="proj-group"
              key={group.kind === 'all' ? 'all' : 'folder:' + (path ?? 'none')}
            >
              {group.kind !== 'all' ? (
                <div className="proj-label">
                  {fp?.color ? (
                    <span className="proj-dot" style={{ background: fp.color }} />
                  ) : null}
                  <Icon size={16} />
                  <span>{label}</span>
                  {path ? (
                    <span className="proj-actions">
                      {/* Order matches Antigravity: gear (settings) then + (new). */}
                      <button
                        className="row-act"
                        title="Project settings"
                        onClick={(e) => {
                          e.stopPropagation()
                          openProjectSettings(path)
                        }}
                      >
                        <IconSettings size={13} />
                      </button>
                      <button
                        className="row-act"
                        title="New conversation in this folder"
                        onClick={(e) => {
                          e.stopPropagation()
                          void newConversationInProject(path)
                        }}
                      >
                        <IconPlus size={13} />
                      </button>
                    </span>
                  ) : null}
                </div>
              ) : null}
              {group.convoIds.map((id) => {
                const convo = conversations[id]
                if (!convo) return null
                const running =
                  convo.runState === 'running' || convo.runState === 'awaiting-approval'
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
                        <ConvoRowMenu convoId={id} title={convo.title} />
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
          )
        })}
      </div>

      <div className="sidebar-footer">
        <Hint label="Open Settings" keys="⌘," side="right">
          <button className="nav-item" onClick={() => openSettings()}>
            <IconSettings />
            Settings
          </button>
        </Hint>
      </div>
    </div>
  )
}
