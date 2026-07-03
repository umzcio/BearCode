import { Composer } from './Composer/Composer'
import { HOME_WORKSPACE } from '../demo/data'
import { useAppStore } from '../state/store'
import { IconChevronDown, IconFolder } from './icons'
import './Home.css'

export function Home(): React.JSX.Element {
  const startFromHome = useAppStore((s) => s.startFromHome)
  const showToast = useAppStore((s) => s.showToast)

  return (
    <div className="home">
      <div className="composer-wrap">
        <div
          className="workspace-row"
          title="Folder picker coming soon"
          onClick={() => showToast('Folder picker is coming soon')}
        >
          <IconFolder />
          <span>{HOME_WORKSPACE.shortLabel}</span>
          <span className="workspace-chev">
            <IconChevronDown />
          </span>
        </div>
        <Composer onSend={startFromHome} showEnvRow autoFocus />
      </div>
    </div>
  )
}
