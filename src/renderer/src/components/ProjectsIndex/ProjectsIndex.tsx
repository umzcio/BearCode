import { useMemo, useState } from 'react'
import { HERMES_MODEL_REF, type FolderProject } from '@shared/types'
import { useAppStore } from '../../state/store'
import { groupConversations, type ConvoLike } from '../Sidebar/grouping'
import { EmptyState } from '../ui/EmptyState'
import { Hint } from '../Hint'
import { Select, type SelectOption } from '../Select'
import { IconFolder, IconPin, IconPlus, IconSettings, IconTerminal } from '../icons'
import { projectIcon } from '../ProjectSettings/projectIcons'
import './ProjectsIndex.css'

type ProjectSort = 'name' | 'updated' | 'count'

const SORT_OPTIONS: SelectOption<ProjectSort>[] = [
  { value: 'updated', label: 'Last Activity' },
  { value: 'name', label: 'Name' },
  { value: 'count', label: 'Conversation Count' }
]

// A project path that has real conversations but has never been
// renamed/colored/iconed/pinned has no `project_settings` row yet. Same
// default shape ProjectSettingsModal.tsx uses for an unconfigured folder, so
// this page's rows and that modal agree on what "unconfigured" looks like.
function placeholderProject(path: string): FolderProject {
  return {
    path,
    name: null,
    color: null,
    icon: null,
    defaultModelRef: null,
    defaultEffort: null,
    defaultPermissionMode: null,
    sandboxMode: false,
    sandboxAllowNetwork: false,
    trusted: false,
    outsideFolderAccess: 'ask',
    outsideFolderAllowedPaths: [],
    outsideFolderDeniedPaths: [],
    outsideFolderPendingPaths: [],
    pinned: false
  }
}

// Cross-project index page (sidebar redesign, claude.ai-style "Projects"
// link): every folder from `folderSettings`, one row each, with its own
// sort control -- separate from the sidebar's Recent Conversations sort
// (DisplayOptions), which this page never touches.
export function ProjectsIndex(): React.JSX.Element {
  const folderSettings = useAppStore((s) => s.folderSettings)
  const convoOrder = useAppStore((s) => s.convoOrder)
  const conversations = useAppStore((s) => s.conversations)
  const view = useAppStore((s) => s.view)
  const openProjectPage = useAppStore((s) => s.openProjectPage)
  const openProjectSettings = useAppStore((s) => s.openProjectSettings)
  const openTerminalView = useAppStore((s) => s.openTerminalView)
  const newConversationInProject = useAppStore((s) => s.newConversationInProject)
  const toggleProjectPinned = useAppStore((s) => s.toggleProjectPinned)
  const [sort, setSort] = useState<ProjectSort>('updated')

  // Reuse the sidebar's own grouping helper for conversation counts +
  // per-project last-activity, rather than re-deriving it.
  const nonHermesOrder = useMemo(
    () => convoOrder.filter((id) => conversations[id]?.modelRef !== HERMES_MODEL_REF),
    [convoOrder, conversations]
  )
  const groups = useMemo(
    () =>
      groupConversations(nonHermesOrder, conversations as Record<string, ConvoLike | undefined>, {
        groupBy: 'project',
        sort: 'updated',
        showArchived: true
      }),
    [nonHermesOrder, conversations]
  )

  // The true "every project" list is every distinct project path that has at
  // least one (loaded) conversation -- `groups` above, built off ALL
  // conversations loaded at app init, not just whatever happens to be open in
  // this view -- UNIONED with any `folderSettings` rows that currently have
  // zero conversations (e.g. a pinned/customized project with none yet).
  // `folderSettings` alone is NOT the full project list: it's a sparse
  // per-project settings-override table that only gets a row once a project
  // is renamed/colored/iconed/pinned, or a conversation is started via the
  // "+" new-conversation-in-project flow -- most projects (opened by cwd,
  // imported, etc.) never get one. Iterating `folderSettings` as the primary
  // list (the previous implementation) meant a project with zero customization
  // and zero conversations created *this session* was invisible even though
  // it has real, persisted conversations.
  const rows = useMemo(() => {
    const byPath = new Map(folderSettings.map((fp) => [fp.path, fp]))
    const seen = new Set<string>()
    const out: { fp: FolderProject; count: number; lastActivity: number }[] = []
    for (const g of groups) {
      if (g.kind !== 'folder' || g.path == null) continue
      seen.add(g.path)
      const lastActivity = g.convoIds.reduce(
        (max, id) => Math.max(max, conversations[id]?.updatedAt ?? 0),
        0
      )
      out.push({
        fp: byPath.get(g.path) ?? placeholderProject(g.path),
        count: g.convoIds.length,
        lastActivity
      })
    }
    for (const fp of folderSettings) {
      if (seen.has(fp.path)) continue
      out.push({ fp, count: 0, lastActivity: 0 })
    }
    return out
  }, [groups, folderSettings, conversations])

  const sorted = useMemo(() => {
    const copy = [...rows]
    copy.sort((a, b) => {
      if (sort === 'name') {
        const aLabel = a.fp.name ?? a.fp.path.split('/').pop() ?? a.fp.path
        const bLabel = b.fp.name ?? b.fp.path.split('/').pop() ?? b.fp.path
        return aLabel.localeCompare(bLabel)
      }
      if (sort === 'count') return b.count - a.count
      return b.lastActivity - a.lastActivity
    })
    return copy
  }, [rows, sort])

  return (
    <div className="projects-index">
      <div className="pidx-head">
        <span className="pidx-icon">
          <IconFolder size={17} />
        </span>
        <div className="pidx-title">
          <h3>Projects</h3>
          <div className="pidx-meta">
            {rows.length} project{rows.length === 1 ? '' : 's'}
          </div>
        </div>
        <div className="pidx-sort">
          <Select
            value={sort}
            options={SORT_OPTIONS}
            onChange={setSort}
            ariaLabel="Sort projects"
            compact
          />
        </div>
      </div>
      <div className="pidx-list">
        {sorted.length === 0 ? (
          <EmptyState title="No projects yet" hint="Open a folder to add your first project." />
        ) : (
          sorted.map(({ fp, count }) => {
            const Icon = projectIcon(fp.icon)
            const label = fp.name ?? fp.path.split('/').pop() ?? fp.path
            const selected = view.kind === 'project' && view.path === fp.path
            return (
              <div
                key={fp.path}
                className={'pidx-row' + (selected ? ' selected' : '')}
                role="button"
                tabIndex={0}
                onClick={() => openProjectPage(fp.path)}
                onKeyDown={(e) => {
                  // Ignore keys originating on the nested Pin button (mirrors
                  // ProjectPage.tsx's identical row-vs-action convention).
                  if (e.target !== e.currentTarget) return
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    openProjectPage(fp.path)
                  }
                }}
              >
                <span
                  className="chip"
                  style={fp.color ? { background: fp.color + '2e', color: fp.color } : undefined}
                >
                  <Icon size={13} />
                </span>
                <span className="name">{label}</span>
                <span className="cnt">
                  {count} conversation{count === 1 ? '' : 's'}
                </span>
                <span className="pidx-rowact">
                  <Hint label="Project settings">
                    <button
                      type="button"
                      className="row-act"
                      aria-label="Project settings"
                      onClick={(e) => {
                        e.stopPropagation()
                        openProjectSettings(fp.path)
                      }}
                    >
                      <IconSettings size={13} />
                    </button>
                  </Hint>
                  <Hint label="Open terminal">
                    <button
                      type="button"
                      className="row-act"
                      aria-label="Open terminal"
                      onClick={(e) => {
                        e.stopPropagation()
                        openTerminalView(fp.path)
                      }}
                    >
                      <IconTerminal size={13} />
                    </button>
                  </Hint>
                  <Hint label="New conversation">
                    <button
                      type="button"
                      className="row-act"
                      aria-label="New conversation"
                      onClick={(e) => {
                        e.stopPropagation()
                        void newConversationInProject(fp.path)
                      }}
                    >
                      <IconPlus size={13} />
                    </button>
                  </Hint>
                  <Hint label={fp.pinned ? 'Unpin project' : 'Pin project'}>
                    <button
                      type="button"
                      className={'row-act' + (fp.pinned ? ' active' : '')}
                      aria-label={fp.pinned ? 'Unpin project' : 'Pin project'}
                      onClick={(e) => {
                        e.stopPropagation()
                        void toggleProjectPinned(fp.path)
                      }}
                    >
                      <IconPin size={13} />
                    </button>
                  </Hint>
                </span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
