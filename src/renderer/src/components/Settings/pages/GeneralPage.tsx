import type { JSX } from 'react'
import { useAppStore } from '../../../state/store'
import { SettingPlaceholder } from '../SettingPlaceholder'

export function GeneralPage(): JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const deleteAll = useAppStore((s) => s.deleteAllConversations)

  if (!settings) return null

  return (
    <>
      <div className="page-title">General</div>
      <div className="page-sub">Your profile, custom instructions, and application data.</div>

      <SettingPlaceholder
        title="Profile & Custom Instructions"
        description="Set your name, avatar, and global custom instructions — coming in the next update."
      />

      <div className="set-group-title">Data</div>
      <div className="set-card">
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-title">Location</div>
            <div className="set-row-desc">{settings.dataPath}</div>
          </div>
          <span />
        </div>
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-title">Delete All Conversations</div>
            <div className="set-row-desc">
              Removes every conversation and staged diff. This cannot be undone.
            </div>
          </div>
          <button
            className="danger-btn"
            onClick={() => {
              if (window.confirm('Delete all conversations? This cannot be undone.')) {
                void deleteAll()
              }
            }}
          >
            Delete
          </button>
        </div>
      </div>
    </>
  )
}
