import { useEffect } from 'react'
import { useAppStore } from '../../state/store'
import { useShallow } from 'zustand/react/shallow'
import { TerminalPane } from './TerminalPane'
import { IconPlus, IconClose, IconTerminal } from '../icons'
import './TerminalView.css'

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

  // Hydrate from any sessions the main process already has for this path
  // (e.g. this project's Terminal view was open earlier this app session,
  // then navigated away from and back to -- the ptys kept running). Only
  // seeds tabs when the store has none recorded for this path yet, so it
  // never fights a tab the user just created.
  useEffect(() => {
    if (tabs.length > 0) return
    void window.bearcode.terminal.list(path).then((sessions) => {
      if (sessions.length === 0) {
        void createTerminalTab(path)
        return
      }
      useAppStore.setState((s) => ({
        terminalTabs: {
          ...s.terminalTabs,
          [path]: sessions.map((v) => ({ id: v.id, title: v.title, exited: v.exited }))
        },
        activeTerminalTab: { ...s.activeTerminalTab, [path]: sessions[0].id }
      }))
    })
    // Runs once per path mount -- deliberately excludes `tabs`/`createTerminalTab`
    // from deps so it never re-fires as the tab list it just seeded changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  return (
    <div className="terminal-view">
      <div className="terminal-tabstrip">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={
              'terminal-tab' + (tab.id === activeId ? ' active' : '') + (tab.exited ? ' exited' : '')
            }
            onClick={() => setActiveTerminalTab(path, tab.id)}
          >
            <IconTerminal size={13} />
            <span>{tab.exited ? `${tab.title} (exited)` : tab.title}</span>
            <span
              className="terminal-tab-close"
              role="button"
              aria-label="Close terminal tab"
              onClick={(e) => {
                e.stopPropagation()
                void closeTerminalTab(path, tab.id)
              }}
            >
              <IconClose size={11} />
            </span>
          </button>
        ))}
        <button
          className="terminal-tab-new"
          aria-label="New terminal tab"
          onClick={() => void createTerminalTab(path)}
        >
          <IconPlus size={13} />
        </button>
      </div>
      <div className="terminal-panes">
        {tabs.map((tab) => (
          <TerminalPane key={tab.id} id={tab.id} path={path} active={tab.id === activeId} />
        ))}
      </div>
    </div>
  )
}
