import { useMemo } from 'react'
import { HERMES_MODEL_REF } from '@shared/types'
import { useAppStore } from '../../state/store'
import { relativeAge } from '../../lib/time'
import { EmptyState } from '../ui/EmptyState'
import { Hint } from '../Hint'
import { ConvoRow } from '../Sidebar/ConvoRow'
import { IconFolder, IconPin, IconPlus, IconSettings, IconTerminal } from '../icons'
import { projectIcon } from '../ProjectSettings/projectIcons'
import './ProjectPage.css'

function dayBucket(updatedAt: number, now: number): 'Today' | 'This week' | 'Older' {
  const days = Math.floor((now - updatedAt) / 86_400_000)
  if (days < 1) return 'Today'
  if (days < 7) return 'This week'
  return 'Older'
}

export function ProjectPage({ path }: { path: string | null }): React.JSX.Element {
  const conversations = useAppStore((s) => s.conversations)
  const convoOrder = useAppStore((s) => s.convoOrder)
  const folderSettings = useAppStore((s) => s.folderSettings)
  const openProjectSettings = useAppStore((s) => s.openProjectSettings)
  const openTerminalView = useAppStore((s) => s.openTerminalView)
  const newConversationInProject = useAppStore((s) => s.newConversationInProject)
  const openConvo = useAppStore((s) => s.openConvo)
  const setPinned = useAppStore((s) => s.setPinned)
  const setArchived = useAppStore((s) => s.setArchived)
  const toggleProjectPinned = useAppStore((s) => s.toggleProjectPinned)
  const goHome = useAppStore((s) => s.goHome)
  const showArchived = useAppStore((s) => s.settings?.sidebarShowArchived ?? false)
  const subtitle = useAppStore((s) => s.settings?.sidebarSubtitle ?? 'none')

  const fp = path ? folderSettings.find((f) => f.path === path) : undefined
  const Icon = path ? projectIcon(fp?.icon) : IconFolder
  const label = path ? (fp?.name ?? path.split('/').pop() ?? path) : 'No folder'

  const ids = useMemo(
    () =>
      convoOrder
        .filter(
          (id) =>
            conversations[id]?.projectPath === path &&
            conversations[id]?.modelRef !== HERMES_MODEL_REF &&
            (showArchived || !conversations[id]?.archived)
        )
        .sort((a, b) => (conversations[b]?.updatedAt ?? 0) - (conversations[a]?.updatedAt ?? 0)),
    [convoOrder, conversations, path, showArchived]
  )

  const now = Date.now()
  const buckets: { label: string; ids: string[] }[] = []
  for (const label of ['Today', 'This week', 'Older'] as const) {
    const bucketIds = ids.filter((id) => dayBucket(conversations[id]?.updatedAt ?? 0, now) === label)
    if (bucketIds.length > 0) buckets.push({ label, ids: bucketIds })
  }

  return (
    <div className="project-page">
      <div className="pp-head">
        <span className="pp-icon">
          <Icon size={17} />
        </span>
        <div className="pp-title">
          <h3>{label}</h3>
          <div className="pp-meta">
            {ids.length} conversation{ids.length === 1 ? '' : 's'}
          </div>
        </div>
        <div className="pp-actions">
          {path ? (
            <Hint label={fp?.pinned ? 'Unpin project' : 'Pin project'}>
              <button
                type="button"
                className={'pp-btn pp-pin' + (fp?.pinned ? ' active' : '')}
                aria-label={fp?.pinned ? 'Unpin project' : 'Pin project'}
                onClick={() => void toggleProjectPinned(path)}
              >
                <IconPin size={13} />
              </button>
            </Hint>
          ) : null}
          {path ? (
            <button type="button" className="pp-btn" onClick={() => openProjectSettings(path)}>
              <IconSettings size={13} />
              Settings
            </button>
          ) : null}
          {path ? (
            <button type="button" className="pp-btn" onClick={() => openTerminalView(path)}>
              <IconTerminal size={13} />
              Terminal
            </button>
          ) : null}
          <button
            type="button"
            className="pp-btn primary"
            onClick={() => (path ? void newConversationInProject(path) : goHome())}
          >
            <IconPlus size={13} />
            New
          </button>
        </div>
      </div>
      <div className="pp-list">
        {ids.length === 0 ? (
          <EmptyState title="No conversations yet" />
        ) : (
          buckets.map((bucket) => (
            <div key={bucket.label}>
              <div className="pp-daylabel">{bucket.label}</div>
              {bucket.ids.map((id) => {
                const convo = conversations[id]
                if (!convo) return null
                return (
                  <ConvoRow
                    key={id}
                    id={id}
                    title={convo.title}
                    pinned={convo.pinned}
                    archived={convo.archived}
                    subtitle={
                      subtitle === 'worktree' && convo.environment === 'worktree' && convo.worktrees[0]
                        ? convo.worktrees[0].branch
                        : undefined
                    }
                    age={relativeAge(convo.updatedAt)}
                    rowClassName="pp-row"
                    actionsClassName="pp-rowact"
                    onOpen={() => openConvo(id)}
                    onTogglePinned={() => setPinned(id, !convo.pinned)}
                    onToggleArchived={() => setArchived(id, !convo.archived)}
                  />
                )
              })}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
