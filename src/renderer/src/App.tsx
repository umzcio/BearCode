import { useEffect, useRef, useState } from 'react'
import { WindowChromeControls } from './components/WindowChrome/WindowChromeControls'
import { Sidebar, type SidebarMotionControl } from './components/Sidebar/Sidebar'
import { Menu, type MenuGroup } from './components/ui/Menu'
import { IconChevronDown } from './components/icons'
import { Home } from './components/Home'
import { HistoryView } from './components/History/HistoryView'
import { TerminalView } from './components/Terminal/TerminalView'
import { ProjectPage } from './components/ProjectPage/ProjectPage'
import { ProjectsIndex } from './components/ProjectsIndex/ProjectsIndex'
import { ModelsPage } from './components/ModelsPage/ModelsPage'
import { ConversationView } from './components/ConversationView'
import { ArtifactsPane } from './components/ArtifactsPane'
import { ResizeHandle } from './components/ResizeHandle'
import { SettingsView } from './components/Settings/SettingsView'
import { ProjectSettingsModal } from './components/ProjectSettings/ProjectSettingsModal'
import { ConflictResolver } from './components/Worktree/ConflictResolver'
import { TrustBanner } from './components/TrustBanner'
import { ImportConfigBanner } from './components/ImportConfigBanner'
import { ImportConfigReviewModal } from './components/ImportConfigReviewModal'
import { OutsideAccessCard } from './components/OutsideAccessCard'
import { UpdateBanner } from './components/UpdateBanner'
import { Toaster } from './components/ui/sonner'
import { useAppStore } from './state/store'
import { useCmdHeld } from './lib/useCmdHeld'
import { useShallow } from 'zustand/react/shallow'
import './App.css'

function App(): React.JSX.Element {
  const collapsed = useAppStore((s) => s.sidebarCollapsed)
  const view = useAppStore((s) => s.view)
  const convo = useAppStore(
    useShallow((s) => {
      if (s.view.kind !== 'conversation') return null
      const c = s.conversations[s.view.id]
      return c
        ? { id: c.id, projectLabel: c.projectLabel, projectPath: c.projectPath, title: c.title }
        : null
    })
  )
  const auxSelection = useAppStore((s) => s.auxSelection)
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth)
  const setAuxPaneWidth = useAppStore((s) => s.setAuxPaneWidth)
  const toast = useAppStore((s) => s.toast)
  const dismissToast = useAppStore((s) => s.dismissToast)
  const init = useAppStore((s) => s.init)
  const cmdHeld = useCmdHeld()
  const sidebarMotionControl = useRef<SidebarMotionControl>({ skipNextAnimation: false })
  const renameConversation = useAppStore((s) => s.renameConversation)
  const deleteConvo = useAppStore((s) => s.deleteConvo)
  const [titleMenuOpen, setTitleMenuOpen] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const titleBtnRef = useRef<HTMLButtonElement>(null)

  const convoMenuGroups: MenuGroup[] = [
    {
      items: [
        { value: 'rename', label: 'Rename' },
        { value: 'delete', label: 'Delete Conversation', danger: true }
      ]
    }
  ]
  const handleConvoMenuSelect = (value: string): void => {
    if (!convo) return
    if (value === 'rename') {
      setEditingTitle(true)
    } else if (value === 'delete') {
      if (window.confirm(`Delete "${convo.title}"?`)) deleteConvo(convo.id)
    }
  }
  const commitTitle = (value: string): void => {
    const next = value.trim()
    if (convo && next && next !== convo.title) renameConversation(convo.id, next)
    setEditingTitle(false)
  }

  useEffect(() => {
    init()
  }, [init])

  // Responsive collapse (Claude-Code / Antigravity style): auto-collapse the
  // left nav on a narrow window so the conversation + composer aren't squished.
  // Edge-triggered on crossing the breakpoint, so a manual toggle still sticks
  // within a size regime.
  useEffect(() => {
    const BP = 820
    let prevNarrow = window.innerWidth < BP
    if (prevNarrow && !useAppStore.getState().sidebarCollapsed) {
      useAppStore.getState().setSidebarCollapsed(true)
    }
    const onResize = (): void => {
      const narrow = window.innerWidth < BP
      if (narrow === prevNarrow) return
      prevNarrow = narrow
      useAppStore.getState().setSidebarCollapsed(narrow)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Global shortcuts: Cmd+1 Projects, Cmd+2 Models, Cmd+N new conversation,
  // Cmd+B sidebar, Cmd+, settings, Cmd+/ model menu, Cmd+. mode menu, and
  // Cmd+L focus the composer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      const s = useAppStore.getState()
      switch (e.key) {
        case '1':
          e.preventDefault()
          s.openProjectsIndex()
          break
        case '2':
          e.preventDefault()
          s.openModelsPage()
          break
        case 'n':
          e.preventDefault()
          s.goHome()
          break
        case 'b':
          e.preventDefault()
          sidebarMotionControl.current.skipNextAnimation = true
          s.toggleSidebar()
          break
        case ',':
          e.preventDefault()
          // Cmd+, toggles: in settings → back to where it was opened from.
          if (s.view.kind === 'settings') s.closeSettings()
          else s.openSettings()
          break
        case '/':
          e.preventDefault()
          s.toggleModelMenu()
          break
        case '.':
          e.preventDefault()
          s.togglePermMenu()
          break
        case ';':
          e.preventDefault()
          s.toggleProjectMenu()
          break
        case 'k':
          e.preventDefault()
          s.openHistory()
          break
        case 'l': {
          e.preventDefault()
          const ta = document.querySelector<HTMLTextAreaElement>('.composer textarea')
          ta?.focus()
          break
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className={'app' + (cmdHeld ? ' cmd-held' : '')}>
      <WindowChromeControls />
      <Sidebar motionControl={sidebarMotionControl.current} />
      {!collapsed ? (
        <ResizeHandle
          onDrag={(dx) =>
            setSidebarWidth(useAppStore.getState().sidebarWidth + dx, { persist: false })
          }
          onDragEnd={() => setSidebarWidth(useAppStore.getState().sidebarWidth)}
        />
      ) : null}
      <div className={'main' + (collapsed ? ' sidebar-collapsed' : '')}>
        <div className="topbar">
          <div className="window-controls-hit-area" aria-hidden="true" />
          {convo ? (
            <div className="breadcrumb">
              {convo.projectPath ? (
                <>
                  <span className="crumb">{convo.projectLabel}</span>
                  <span className="sep">/</span>
                </>
              ) : null}
              {editingTitle ? (
                <input
                  key={convo.id}
                  className="crumb-rename"
                  defaultValue={convo.title}
                  autoFocus
                  onFocus={(e) => e.currentTarget.select()}
                  onBlur={(e) => commitTitle(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                    else if (e.key === 'Escape') setEditingTitle(false)
                  }}
                  aria-label="Rename conversation"
                />
              ) : (
                <button
                  ref={titleBtnRef}
                  type="button"
                  className={
                    titleMenuOpen ? 'crumb current crumb-btn menu-open' : 'crumb current crumb-btn'
                  }
                  onClick={() => setTitleMenuOpen((o) => !o)}
                  aria-haspopup="menu"
                  aria-expanded={titleMenuOpen}
                >
                  <span className="crumb-title">{convo.title}</span>
                  <IconChevronDown />
                </button>
              )}
              <Menu
                anchorRef={titleBtnRef}
                open={titleMenuOpen}
                onClose={() => setTitleMenuOpen(false)}
                groups={convoMenuGroups}
                onSelect={handleConvoMenuSelect}
                placement="bottom-start"
                ariaLabel="Conversation actions"
              />
            </div>
          ) : null}
          {view.kind === 'settings' ? (
            <div className="breadcrumb">
              <span className="crumb current">Settings</span>
            </div>
          ) : null}
        </div>
        <TrustBanner />
        <ImportConfigBanner />
        <OutsideAccessCard />
        <UpdateBanner />
        <div
          className="main-view"
          key={
            view.kind === 'conversation' && convo
              ? `conversation:${convo.id}`
              : view.kind === 'project'
                ? `project:${view.path ?? 'none'}`
                : view.kind === 'terminal'
                  ? `terminal:${view.path}`
                  : view.kind
          }
        >
          {view.kind === 'home' ? <Home /> : null}
          {view.kind === 'history' ? <HistoryView /> : null}
          {view.kind === 'terminal' ? <TerminalView path={view.path} /> : null}
          {view.kind === 'project' ? <ProjectPage path={view.path} /> : null}
          {view.kind === 'projects' ? <ProjectsIndex /> : null}
          {view.kind === 'models' ? <ModelsPage /> : null}
          {view.kind === 'settings' ? <SettingsView /> : null}
          {convo ? <ConversationView key={convo.id} convoId={convo.id} /> : null}
        </div>
        <ProjectSettingsModal />
        <ImportConfigReviewModal />
        <ConflictResolver />
      </div>
      {auxSelection ? (
        <ResizeHandle
          onDrag={(dx) =>
            setAuxPaneWidth(useAppStore.getState().auxPaneWidth - dx, { persist: false })
          }
          onDragEnd={() => setAuxPaneWidth(useAppStore.getState().auxPaneWidth)}
        />
      ) : null}
      <ArtifactsPane />
      {toast ? (
        <div className="toast" role="status" aria-live="polite">
          <span className="toast-msg">{toast.message}</span>
          {toast.action ? (
            <span className="toast-actions">
              <button className="toast-btn" onClick={dismissToast}>
                Dismiss
              </button>
              <button
                className="toast-btn primary"
                onClick={() => {
                  toast.action?.run()
                  dismissToast()
                }}
              >
                {toast.action.label}
              </button>
            </span>
          ) : null}
        </div>
      ) : null}
      <Toaster position="bottom-right" richColors={false} />
    </div>
  )
}

export default App
