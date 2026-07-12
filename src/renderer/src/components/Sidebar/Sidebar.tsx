import { useMemo, useRef, useLayoutEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore, type Convo } from '../../state/store'
import { relativeAge } from '../../lib/time'
import bearMark from '../../assets/bear.svg'
import { Hint } from '../Hint'
import { EmptyState } from '../ui/EmptyState'
import { groupConversations, type ConvoLike } from './grouping'

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
      worktrees: c.worktrees
    }
    convoLikeCache.set(c, cached)
  }
  return cached
}
import { DisplayOptions } from './DisplayOptions'
import { ConvoRowMenu } from './ConvoRowMenu'
import { IconArchive, IconHistory, IconPanel, IconPin, IconPlus, IconSettings } from '../icons'
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
  const goHome = useAppStore((s) => s.goHome)
  const openHistory = useAppStore((s) => s.openHistory)
  const openConvo = useAppStore((s) => s.openConvo)
  const openSettings = useAppStore((s) => s.openSettings)
  const folderSettings = useAppStore((s) => s.folderSettings)
  const setPinned = useAppStore((s) => s.setPinned)
  const setArchived = useAppStore((s) => s.setArchived)
  const newConversationInProject = useAppStore((s) => s.newConversationInProject)
  const openProjectSettings = useAppStore((s) => s.openProjectSettings)
  const groupBy = useAppStore((s) => s.settings?.sidebarGroupBy ?? 'project')
  const sort = useAppStore((s) => s.settings?.sidebarSort ?? 'updated')
  const showArchived = useAppStore((s) => s.settings?.sidebarShowArchived ?? false)
  const subtitle = useAppStore((s) => s.settings?.sidebarSubtitle ?? 'none')

  const groups = useMemo(
    () => groupConversations(convoOrder, conversations, { groupBy, sort, showArchived }),
    [convoOrder, conversations, groupBy, sort, showArchived]
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
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
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
      el.style.transition = 'transform 0.34s cubic-bezier(0.32, 0.72, 0, 1)'
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
        {groups.length === 0 ? (
          <div className="sidebar-empty">
            <EmptyState title="No conversations yet" />
          </div>
        ) : null}
        {groups.map((group) => {
          // Every folder group is a project keyed by its path; look up its
          // stored color/icon/name (a folder with no row shows the default icon
          // and its basename). "No folder" (path null) has no settings + no gear.
          const path = group.kind === 'folder' ? group.path : null
          const fp = path ? folderSettings.find((f) => f.path === path) : undefined
          const Icon = projectIcon(fp?.icon)
          const label = group.kind === 'folder' ? (fp?.name ?? group.label) : ''
          // F3: stable per-kind key so switching Group By re-keys cleanly.
          const key =
            group.kind === 'all'
              ? 'all'
              : group.kind === 'folder'
                ? 'folder:' + (path ?? 'none')
                : group.kind === 'environment'
                  ? 'env:' + group.env
                  : 'status:' + group.bucket
          return (
            <div className="proj-group" key={key}>
              {group.kind === 'folder' ? (
                <div className="proj-label">
                  {fp?.color ? (
                    <span className="proj-dot" style={{ background: fp.color }} />
                  ) : null}
                  <Icon size={16} />
                  <span>{label}</span>
                  {path ? (
                    <span className="proj-actions">
                      {/* Order matches Antigravity: gear (settings) then + (new). */}
                      <Hint label="Project settings" side="bottom">
                        <button
                          className="row-act"
                          aria-label="Project settings"
                          onClick={(e) => {
                            e.stopPropagation()
                            openProjectSettings(path)
                          }}
                        >
                          <IconSettings size={13} />
                        </button>
                      </Hint>
                      <Hint label="New conversation in this folder" side="bottom">
                        <button
                          className="row-act"
                          aria-label="New conversation in this folder"
                          onClick={(e) => {
                            e.stopPropagation()
                            void newConversationInProject(path)
                          }}
                        >
                          <IconPlus size={13} />
                        </button>
                      </Hint>
                    </span>
                  ) : null}
                </div>
              ) : group.kind === 'environment' || group.kind === 'status' ? (
                // F3: Environment/Status buckets are simple label rows — no
                // gear/+ (those are folder-only project actions).
                <div className="proj-label">
                  <span>{group.label}</span>
                </div>
              ) : null}
              {group.convoIds.map((id) => {
                const convo = conversations[id]
                if (!convo) return null
                const running =
                  convo.runState === 'running' || convo.runState === 'awaiting-approval'
                const selected = view.kind === 'conversation' && view.id === id
                // F3: show the worktree branch under the title when the
                // Worktree subtitle is on and this convo has a worktree
                // (first repo drives the subtitle line for multi-repo).
                const branch =
                  subtitle === 'worktree' && convo.environment === 'worktree'
                    ? convo.worktrees[0]?.branch
                    : undefined
                return (
                  <div
                    key={id}
                    className={
                      'convo' + (running ? ' active-run' : '') + (selected ? ' selected' : '')
                    }
                    role="button"
                    tabIndex={0}
                    onClick={() => openConvo(id)}
                    onKeyDown={(e) => {
                      // Ignore keys that originated on a nested action button (Pin/Archive/⋮);
                      // only the row's own focus target should open the conversation.
                      if (e.target !== e.currentTarget) return
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        openConvo(id)
                      }
                    }}
                  >
                    {convo.pinned ? <IconPin size={11} /> : null}
                    <span className="name-wrap">
                      <span className="name">{convo.title}</span>
                      {branch ? <span className="convo-sub">{branch}</span> : null}
                    </span>
                    {running ? (
                      <span className="dot" />
                    ) : (
                      <>
                        <span className="age">{relativeAge(convo.updatedAt)}</span>
                        <ConvoRowMenu convoId={id} title={convo.title} />
                        <Hint label={convo.pinned ? 'Unpin' : 'Pin'} side="bottom">
                          <button
                            className={'row-act' + (convo.pinned ? ' active' : '')}
                            aria-label={convo.pinned ? 'Unpin' : 'Pin'}
                            onClick={(e) => {
                              e.stopPropagation()
                              setPinned(id, !convo.pinned)
                            }}
                          >
                            <IconPin size={13} />
                          </button>
                        </Hint>
                        <Hint label={convo.archived ? 'Unarchive' : 'Archive'} side="bottom">
                          <button
                            className={'row-act' + (convo.archived ? ' active' : '')}
                            aria-label={convo.archived ? 'Unarchive' : 'Archive'}
                            onClick={(e) => {
                              e.stopPropagation()
                              setArchived(id, !convo.archived)
                            }}
                          >
                            <IconArchive size={13} />
                          </button>
                        </Hint>
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
