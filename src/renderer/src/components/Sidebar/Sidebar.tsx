import { useMemo, useRef, useState, useLayoutEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { HERMES_MODEL_REF } from '@shared/types'
import { useAppStore, type Convo } from '../../state/store'
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
      worktrees: c.worktrees,
      modelRef: c.modelRef
    }
    convoLikeCache.set(c, cached)
  }
  return cached
}
import { DisplayOptions } from './DisplayOptions'
import { SidebarFooterMenu } from './SidebarFooterMenu'
import { IconChevronRight, IconHistory, IconPanel, IconPlus, IconSearch } from '../icons'
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
  const goHome = useAppStore((s) => s.goHome)
  const [mode, setMode] = useState<'conversations' | 'hermes'>('conversations')
  const sort = useAppStore((s) => s.settings?.sidebarSort ?? 'updated')
  const showArchived = useAppStore((s) => s.settings?.sidebarShowArchived ?? false)
  const hermesEnabled = useAppStore((s) => s.settings?.hermesEnabled ?? false)
  const hermesLabel = useAppStore((s) => s.settings?.hermesLabel)
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

  // The Projects list is always folder-based in this design (see plan's
  // Global Constraints) -- `groupBy` no longer changes what the sidebar
  // itself renders, only `sort`/`showArchived` do.
  const projectGroups = useMemo(
    () => groupConversations(projectConvoOrder, conversations, { groupBy: 'project', sort, showArchived }),
    [projectConvoOrder, conversations, sort, showArchived]
  )

  const RECENTS_LIMIT = 20

  const pinnedIds = useMemo(
    () =>
      projectConvoOrder
        .filter((id) => {
          const c = conversations[id]
          return c != null && c.pinned && (showArchived || !c.archived)
        })
        .sort((a, b) => (conversations[b]?.updatedAt ?? 0) - (conversations[a]?.updatedAt ?? 0)),
    [projectConvoOrder, conversations, showArchived]
  )

  const recentIds = useMemo(
    () =>
      projectConvoOrder
        .filter((id) => {
          const c = conversations[id]
          return c != null && !c.pinned && (showArchived || !c.archived)
        })
        .sort((a, b) => (conversations[b]?.updatedAt ?? 0) - (conversations[a]?.updatedAt ?? 0))
        .slice(0, RECENTS_LIMIT),
    [projectConvoOrder, conversations, showArchived]
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
            <IconHistory size={13} />
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
          <div className="sb-label">Projects</div>
          {projectGroups.length === 0 ? (
            <div className="sidebar-empty">
              <EmptyState title="No conversations yet" />
            </div>
          ) : (
            projectGroups.map((group) => {
              // groupBy is always 'project' above, so groupConversations only
              // ever returns 'folder' groups here -- the guard just gives TS a
              // discriminated-union narrowing for `.path`/`.label` below.
              if (group.kind !== 'folder') return null
              const path = group.path
              const fp = path ? folderSettings.find((f) => f.path === path) : undefined
              const Icon = projectIcon(fp?.icon)
              const label = fp?.name ?? group.label
              return (
                <button
                  type="button"
                  key={path ?? 'none'}
                  className="sb-projrow"
                  onClick={() => openProjectPage(path)}
                >
                  <span
                    className="chip"
                    style={fp?.color ? { background: fp.color + '2e', color: fp.color } : undefined}
                  >
                    <Icon size={11} />
                  </span>
                  <span className="name">{label}</span>
                  <span className="cnt">{group.convoIds.length}</span>
                  <IconChevronRight />
                </button>
              )
            })
          )}

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
                  <button
                    type="button"
                    key={id}
                    className={'sb-flatrow' + (selected ? ' selected' : '')}
                    onClick={() => openConvo(id)}
                  >
                    <span className="dot" style={{ background: fp?.color ?? 'var(--text-dim)' }} />
                    <span className="name">{convo.title}</span>
                  </button>
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
                  <button
                    type="button"
                    key={id}
                    className={'sb-flatrow' + (selected ? ' selected' : '')}
                    onClick={() => openConvo(id)}
                  >
                    <span className="dot" style={{ background: fp?.color ?? 'var(--text-dim)' }} />
                    <span className="name">{convo.title}</span>
                  </button>
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
