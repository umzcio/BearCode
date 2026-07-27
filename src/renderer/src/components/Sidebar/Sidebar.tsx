import { useMemo, useRef, useState, useLayoutEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { HERMES_MODEL_REF } from '@shared/types'
import { useAppStore, type Convo } from '../../state/store'
import { prefersReducedMotion } from '../../lib/prefersReducedMotion'
import bearMark from '../../assets/bear.svg'
import { Hint } from '../Hint'
import { EmptyState } from '../ui/EmptyState'
import { sortIds, type ConvoLike } from './grouping'

// Cache the projected subset per Convo object reference (audit M-15). The
// store only replaces a convo's object when THAT convo changes (see
// upsertEvent/patchConvo), so unrelated convos keep the same reference across
// renders -- caching on it gives useShallow's one-level comparison a stable
// per-id identity to compare against, instead of a fresh literal every call
// that would always look "changed" and re-render (or loop) regardless of
// whether the underlying data actually did.
const convoLikeCache = new WeakMap<Convo, ConvoLike>()
function toConvoLike(c: Convo): ConvoLike {
  let cached = convoLikeCache.get(c)
  if (!cached) {
    cached = {
      id: c.id,
      projectPath: c.projectPath,
      projectLabel: c.projectLabel,
      title: c.title,
      updatedAt: c.updatedAt,
      createdAt: c.createdAt,
      pinned: c.pinned,
      archived: c.archived,
      runState: c.runState,
      environment: c.environment,
      worktrees: c.worktrees,
      modelRef: c.modelRef
    }
    convoLikeCache.set(c, cached)
  }
  return cached
}
import { DisplayOptions } from './DisplayOptions'
import { SidebarFooterMenu } from './SidebarFooterMenu'
import { ConvoRow } from './ConvoRow'
import { IconFolder, IconPanel, IconPlus, IconSearch, IconSettings, IconTerminal } from '../icons'
import { projectIcon } from '../ProjectSettings/projectIcons'
import './Sidebar.css'

export function Sidebar(): React.JSX.Element {
  const collapsed = useAppStore((s) => s.sidebarCollapsed)
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const view = useAppStore((s) => s.view)
  const convoOrder = useAppStore((s) => s.convoOrder)
  // Project only the fields grouping/rendering read, so streamed `events`
  // churn no longer re-renders the whole sidebar. (audit M-15)
  const conversations = useAppStore(
    useShallow((s) => {
      const out: Record<string, ConvoLike | undefined> = {}
      for (const id of s.convoOrder) {
        const c = s.conversations[id]
        if (c) out[id] = toConvoLike(c)
      }
      return out
    })
  )
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const openHistory = useAppStore((s) => s.openHistory)
  const openConvo = useAppStore((s) => s.openConvo)
  const folderSettings = useAppStore((s) => s.folderSettings)
  const openProjectPage = useAppStore((s) => s.openProjectPage)
  const openProjectSettings = useAppStore((s) => s.openProjectSettings)
  const openTerminalView = useAppStore((s) => s.openTerminalView)
  const newConversationInProject = useAppStore((s) => s.newConversationInProject)
  const openProjectsIndex = useAppStore((s) => s.openProjectsIndex)
  const goHome = useAppStore((s) => s.goHome)
  const setPinned = useAppStore((s) => s.setPinned)
  const setArchived = useAppStore((s) => s.setArchived)
  const [mode, setMode] = useState<'conversations' | 'hermes'>('conversations')
  const sort = useAppStore((s) => s.settings?.sidebarSort ?? 'updated')
  const subtitle = useAppStore((s) => s.settings?.sidebarSubtitle ?? 'none')
  const showArchived = useAppStore((s) => s.settings?.sidebarShowArchived ?? false)
  const hermesEnabled = useAppStore((s) => s.settings?.hermesEnabled ?? false)
  const hermesLabel = useAppStore((s) => s.settings?.hermesLabel)
  const hermesIcon = useAppStore((s) => s.settings?.hermesIcon)
  const newHermesConversation = useAppStore((s) => s.newHermesConversation)

  // Hermes conversations are project-less (projectPath: null), so they'd
  // otherwise land in the "No folder" project group. Pull them out into their
  // own recency-sorted list and drop them from what groupConversations sees,
  // so a Hermes conversation never renders twice.
  const hermesConvoIds = useMemo(
    () =>
      convoOrder
        .filter((id) => conversations[id]?.modelRef === HERMES_MODEL_REF)
        .sort((a, b) => (conversations[b]?.updatedAt ?? 0) - (conversations[a]?.updatedAt ?? 0)),
    [convoOrder, conversations]
  )
  const projectConvoOrder = useMemo(
    () => convoOrder.filter((id) => conversations[id]?.modelRef !== HERMES_MODEL_REF),
    [convoOrder, conversations]
  )

  // Cross-project "Pinned Projects" section (sidebar redesign): only the
  // handful of projects the user starred, distinct from the "Pinned"
  // section below (pinned CONVERSATIONS). The full project list now lives
  // on the dedicated Projects index page (openProjectsIndex).
  const pinnedProjects = useMemo(() => folderSettings.filter((fp) => fp.pinned), [folderSettings])

  const RECENTS_LIMIT = 20

  const pinnedIds = useMemo(
    () =>
      sortIds(
        projectConvoOrder.filter((id) => {
          const c = conversations[id]
          return c != null && c.pinned && (showArchived || !c.archived)
        }),
        conversations,
        sort
      ),
    [projectConvoOrder, conversations, showArchived, sort]
  )

  const recentIds = useMemo(
    () =>
      sortIds(
        projectConvoOrder.filter((id) => {
          const c = conversations[id]
          return c != null && !c.pinned && (showArchived || !c.archived)
        }),
        conversations,
        sort
      ).slice(0, RECENTS_LIMIT),
    [projectConvoOrder, conversations, showArchived, sort]
  )

  // FLIP collapse animation (apple-design §11): margin-left has already snapped
  // to its final value by the time this runs (one reflow, not per-frame), so we
  // invert the sidebar back to where it *was* with an instant transform, then
  // play a GPU-composited transform to 0. The heavy conversation list is
  // rasterized once and slid as a texture -- no per-frame re-raster => smooth.
  const sidebarRef = useRef<HTMLDivElement>(null)
  const prevCollapsed = useRef(collapsed)
  useLayoutEffect(() => {
    if (prevCollapsed.current === collapsed) return
    prevCollapsed.current = collapsed
    const el = sidebarRef.current
    if (!el) return
    if (prefersReducedMotion()) return
    const dist = sidebarWidth + 1
    // Collapsing: box shifted left by `dist`, so invert with +dist. Expanding: inverse.
    // Promote to a GPU layer NOW (will-change) so the layer already exists on the
    // first animated frame -- avoids a create-layer hitch at the start. translate3d
    // (not translateX) forces compositing.
    el.style.willChange = 'transform'
    el.style.transition = 'none'
    el.style.transform = `translate3d(${collapsed ? dist : -dist}px, 0, 0)`
    void el.offsetWidth // commit the inverted start before animating
    const raf = requestAnimationFrame(() => {
      const rootStyle = getComputedStyle(document.documentElement)
      const ease = rootStyle.getPropertyValue('--ease-drawer').trim()
      const dur = rootStyle.getPropertyValue('--dur-drawer').trim()
      if (!ease || !dur) {
        // Escape hatch: --ease-drawer/--dur-drawer failed to resolve from :root.
        // Do NOT fall back to a hardcoded value -- that would silently mask a
        // future token rename/retune. Snap instantly instead (matches the
        // reduced-motion early-return above) and surface the failure loudly.
        console.error(
          'Sidebar FLIP: could not resolve --ease-drawer/--dur-drawer from :root; skipping animation.'
        )
        el.style.transition = ''
        el.style.transform = 'translate3d(0, 0, 0)'
        return
      }
      el.style.transition = `transform ${dur} ${ease}`
      el.style.transform = 'translate3d(0, 0, 0)'
    })
    const done = (e: TransitionEvent): void => {
      if (e.propertyName !== 'transform') return
      el.style.willChange = ''
      el.style.transition = ''
      el.removeEventListener('transitionend', done)
    }
    el.addEventListener('transitionend', done)
    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener('transitionend', done)
    }
  }, [collapsed, sidebarWidth])

  return (
    <div
      ref={sidebarRef}
      className={'sidebar' + (collapsed ? ' collapsed' : '')}
      style={{
        width: sidebarWidth,
        minWidth: sidebarWidth,
        marginLeft: collapsed ? -(sidebarWidth + 1) : undefined
      }}
    >
      <div className="chrome">
        <Hint label="Toggle Sidebar" keys="⌘B" side="bottom">
          <button className="chrome-btn" onClick={toggleSidebar} aria-label="Toggle sidebar">
            <IconPanel />
          </button>
        </Hint>
        <Hint label="History" side="bottom">
          <button className="chrome-btn" onClick={openHistory} aria-label="History">
            <IconSearch />
          </button>
        </Hint>
      </div>

      {hermesEnabled ? (
        <div className="seg-toggle">
          <button
            type="button"
            className={mode === 'conversations' ? 'active' : ''}
            onClick={() => setMode('conversations')}
          >
            <img src={bearMark} alt="" />
            Conversations
          </button>
          <button
            type="button"
            className={mode === 'hermes' ? 'active' : ''}
            onClick={() => setMode('hermes')}
          >
            {(() => {
              const HermesIcon = projectIcon(hermesIcon)
              return <HermesIcon size={13} />
            })()}
            {hermesLabel || 'Hermes'}
          </button>
        </div>
      ) : null}

      <Hint label="New Conversation" keys="⌘N" side="right">
        <button
          className={'nav-item' + (view.kind === 'home' ? ' selected' : '')}
          onClick={() => (mode === 'hermes' && hermesEnabled ? void newHermesConversation() : goHome())}
        >
          <IconPlus />
          New Conversation
        </button>
      </Hint>

      {mode === 'hermes' && hermesEnabled ? null : (
        <button
          className={'nav-item' + (view.kind === 'projects' ? ' selected' : '')}
          onClick={openProjectsIndex}
        >
          <IconFolder />
          Projects
        </button>
      )}

      <div className="sb-scroll">
      {mode === 'hermes' && hermesEnabled ? (
        <div className="sb-recents">
          <div className="sb-label">Recents</div>
          {hermesConvoIds.length === 0 ? (
            <div className="sidebar-empty">
              <EmptyState title="No Hermes conversations yet" />
            </div>
          ) : (
            hermesConvoIds.map((id) => {
              const convo = conversations[id]
              if (!convo) return null
              const selected = view.kind === 'conversation' && view.id === id
              return (
                <button
                  type="button"
                  key={id}
                  className={'sb-flatrow' + (selected ? ' selected' : '')}
                  onClick={() => openConvo(id)}
                >
                  <span className="name">{convo.title}</span>
                </button>
              )
            })
          )}
        </div>
      ) : (
        <>
          {pinnedProjects.length > 0 ? (
            <>
              <div className="sb-label">Pinned Projects</div>
              {pinnedProjects.map((fp) => {
                const Icon = projectIcon(fp.icon)
                const label = fp.name ?? fp.path.split('/').pop() ?? fp.path
                const selected = view.kind === 'project' && view.path === fp.path
                return (
                  <div
                    key={fp.path}
                    className={'sb-flatrow' + (selected ? ' selected' : '')}
                    role="button"
                    tabIndex={0}
                    onClick={() => openProjectPage(fp.path)}
                    onKeyDown={(e) => {
                      // Ignore keys that originated on the nested Settings
                      // action -- only the row's own focus target should open
                      // the project. Mirrors the Pinned conversation row
                      // convention just below.
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
                      <Icon size={11} />
                    </span>
                    <span className="name">{label}</span>
                    <span className="sb-rowact">
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
                    </span>
                  </div>
                )
              })}
            </>
          ) : null}

          {pinnedIds.length > 0 ? (
            <>
              <div className="sb-label">Pinned</div>
              {pinnedIds.map((id) => {
                const convo = conversations[id]
                if (!convo) return null
                const fp = convo.projectPath
                  ? folderSettings.find((f) => f.path === convo.projectPath)
                  : undefined
                const selected = view.kind === 'conversation' && view.id === id
                return (
                  <ConvoRow
                    key={id}
                    id={id}
                    title={convo.title}
                    pinned={convo.pinned}
                    archived={convo.archived}
                    selected={selected}
                    dotColor={fp?.color ?? 'var(--text-dim)'}
                    subtitle={
                      subtitle === 'worktree' && convo.environment === 'worktree' && convo.worktrees[0]
                        ? convo.worktrees[0].branch
                        : undefined
                    }
                    rowClassName="sb-flatrow"
                    actionsClassName="sb-rowact"
                    onOpen={() => openConvo(id)}
                    onTogglePinned={() => setPinned(id, !convo.pinned)}
                    onToggleArchived={() => setArchived(id, !convo.archived)}
                  />
                )
              })}
            </>
          ) : null}

          <div className="sb-recents">
            <div className="sb-label">
              Recents
              <DisplayOptions />
            </div>
            {recentIds.length === 0 ? (
              <div className="sidebar-empty">
                <EmptyState title="No conversations yet" />
              </div>
            ) : (
              recentIds.map((id) => {
                const convo = conversations[id]
                if (!convo) return null
                const fp = convo.projectPath
                  ? folderSettings.find((f) => f.path === convo.projectPath)
                  : undefined
                const selected = view.kind === 'conversation' && view.id === id
                return (
                  <ConvoRow
                    key={id}
                    id={id}
                    title={convo.title}
                    pinned={convo.pinned}
                    archived={convo.archived}
                    selected={selected}
                    dotColor={fp?.color ?? 'var(--text-dim)'}
                    subtitle={
                      subtitle === 'worktree' && convo.environment === 'worktree' && convo.worktrees[0]
                        ? convo.worktrees[0].branch
                        : undefined
                    }
                    rowClassName="sb-flatrow"
                    actionsClassName="sb-rowact"
                    onOpen={() => openConvo(id)}
                    onTogglePinned={() => setPinned(id, !convo.pinned)}
                    onToggleArchived={() => setArchived(id, !convo.archived)}
                  />
                )
              })
            )}
          </div>
        </>
      )}
      </div>

      <SidebarFooterMenu />
    </div>
  )
}
