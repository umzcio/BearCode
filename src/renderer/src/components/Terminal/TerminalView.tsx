import { useEffect, useState } from 'react'
import { useAppStore } from '../../state/store'
import { useShallow } from 'zustand/react/shallow'
import { TerminalPane } from './TerminalPane'
import { IconPlus, IconClose, IconTerminal } from '../icons'
import { ErrorCard } from '../ui/ErrorCard'
import { EmptyState } from '../ui/EmptyState'
import { Hint } from '../Hint'
import './TerminalView.css'

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function TerminalView({ path }: { path: string }): React.JSX.Element {
  // Select the stable `terminalTabs` record and do the `[path] ?? []` fallback
  // in render, NOT inside the selector -- a `?? []` inside the selector returns
  // a fresh array every call, which makes useSyncExternalStore see a changed
  // snapshot each render and loop ("getSnapshot should be cached" -> "Maximum
  // update depth exceeded"). See OutsideAccessCard.tsx for the same gotcha.
  const terminalTabsByPath = useAppStore((s) => s.terminalTabs)
  const tabs = terminalTabsByPath[path] ?? []
  const activeId = useAppStore((s) => s.activeTerminalTab[path])
  const { createTerminalTab, closeTerminalTab, setActiveTerminalTab } = useAppStore(
    useShallow((s) => ({
      createTerminalTab: s.createTerminalTab,
      closeTerminalTab: s.closeTerminalTab,
      setActiveTerminalTab: s.setActiveTerminalTab
    }))
  )

  // Surfaces a spawn/list failure via the shared <ErrorCard> instead of a
  // silent blank pane. `hydrated` gates the <EmptyState> below so it can
  // never flash during the one-shot auto-create path in the effect below --
  // it only flips true once that path has fully settled (or never runs
  // because this path already had tabs).
  const [error, setError] = useState<string | null>(null)
  const [hydrated, setHydrated] = useState(false)

  // Hydrate from any sessions the main process already has for this path
  // (e.g. this project's Terminal view was open earlier this app session,
  // then navigated away from and back to -- the ptys kept running). Only
  // seeds tabs when the store has none recorded for this path yet, so it
  // never fights a tab the user just created.
  useEffect(() => {
    if (tabs.length > 0) {
      // Nothing to hydrate -- but still mark hydrated so the empty state
      // below can appear later if the user closes every tab this path
      // already had.
      setHydrated(true)
      return
    }
    // StrictMode-safe guard (matches HistoryView.tsx's debounced-search effect
    // and ConversationView.tsx's AttachmentPill effect): dev StrictMode mounts
    // this effect, fires its cleanup, then mounts it again before either
    // `list()` call resolves. Without `cancelled`, both passes can see
    // `tabs.length === 0` and both create a tab, spawning two real ptys. The
    // cleanup flips this closure's flag so a stale pass no-ops instead of
    // creating/seeding on top of the second (live) pass.
    let cancelled = false
    void window.bearcode.terminal.list(path).then(
      (sessions) => {
        if (cancelled) return
        setError(null)
        if (sessions.length === 0) {
          // Don't flip `hydrated` until this settles -- otherwise there's a
          // one-tick window where `hydrated` is true and `tabs` is still
          // empty (this create hasn't landed in the store yet), which would
          // flash the empty state during the normal one-shot auto-create.
          createTerminalTab(path)
            .then(() => {
              if (!cancelled) setError(null)
            })
            .catch((err: unknown) => {
              if (!cancelled) setError(toErrorMessage(err))
            })
            .finally(() => {
              if (!cancelled) setHydrated(true)
            })
          return
        }
        useAppStore.setState((s) => ({
          terminalTabs: {
            ...s.terminalTabs,
            [path]: sessions.map((v) => ({ id: v.id, title: v.title, exited: v.exited }))
          },
          activeTerminalTab: { ...s.activeTerminalTab, [path]: sessions[0].id }
        }))
        setHydrated(true)
      },
      (err: unknown) => {
        if (cancelled) return
        setError(toErrorMessage(err))
        setHydrated(true)
      }
    )
    return () => {
      cancelled = true
    }
    // Runs once per path mount -- deliberately excludes `tabs`/`createTerminalTab`
    // from deps so it never re-fires as the tab list it just seeded changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  return (
    <div className="terminal-view">
      <div className="terminal-tabstrip">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={
              'terminal-tab' + (tab.id === activeId ? ' active' : '') + (tab.exited ? ' exited' : '')
            }
            role="button"
            tabIndex={0}
            onClick={() => setActiveTerminalTab(path, tab.id)}
            onKeyDown={(e) => {
              // Ignore keys originating on the nested close button (mirrors
              // ProjectsIndex.tsx's .pidx-row / ProjectPage.tsx's .pp-row
              // row-vs-action convention).
              if (e.target !== e.currentTarget) return
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setActiveTerminalTab(path, tab.id)
              }
            }}
          >
            <IconTerminal size={13} />
            <span>{tab.exited ? `${tab.title} (exited)` : tab.title}</span>
            <button
              type="button"
              className="terminal-tab-close"
              aria-label="Close terminal tab"
              onClick={(e) => {
                e.stopPropagation()
                void closeTerminalTab(path, tab.id)
              }}
            >
              <IconClose size={11} />
            </button>
          </div>
        ))}
        <button
          className="terminal-tab-new"
          aria-label="New terminal tab"
          onClick={() => {
            createTerminalTab(path)
              .then(() => setError(null))
              .catch((err: unknown) => setError(toErrorMessage(err)))
          }}
        >
          <IconPlus size={13} />
        </button>
        <Hint
          label="Commands typed here run in a real, unsandboxed shell — unlike agent-run commands, they are not restricted by BearCode's sandbox."
          side="bottom"
        >
          <span className="terminal-sandbox-notice">Unsandboxed</span>
        </Hint>
      </div>
      {error ? <ErrorCard>{error}</ErrorCard> : null}
      <div className="terminal-panes">
        {hydrated && !error && tabs.length === 0 ? (
          <EmptyState
            title="No terminal sessions"
            hint="Click the + button above to open a new terminal."
          />
        ) : null}
        {tabs.map((tab) => (
          <TerminalPane key={tab.id} id={tab.id} path={path} active={tab.id === activeId} />
        ))}
      </div>
    </div>
  )
}
