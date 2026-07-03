import { Composer } from './Composer/Composer'
import { useAppStore } from '../state/store'
import { IconChevronDown, IconFolder } from './icons'
import './Home.css'

function shorten(path: string): string {
  return path.length > 34 ? path.slice(0, 33) + '…' : path
}

export function Home(): React.JSX.Element {
  const startFromHome = useAppStore((s) => s.startFromHome)
  const pickWorkspace = useAppStore((s) => s.pickWorkspace)
  const workspacePath = useAppStore((s) => s.workspacePath)

  return (
    <div className="home">
      <div className="composer-wrap">
        <div className="workspace-row" onClick={() => void pickWorkspace()}>
          <IconFolder />
          <span>{workspacePath ? shorten(workspacePath) : 'Choose a folder'}</span>
          <span className="workspace-chev">
            <IconChevronDown />
          </span>
        </div>
        <Composer onSend={startFromHome} showEnvRow autoFocus />
      </div>
    </div>
  )
}
