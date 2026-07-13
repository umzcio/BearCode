import { useState } from 'react'
import type { JSX } from 'react'
import { useAppStore } from '../../../state/store'
import { Loading } from '../../ui/Loading'
import { ErrorCard } from '../../ui/ErrorCard'

export function GeneralPage(): JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const saveSettings = useAppStore((s) => s.saveSettings)
  const deleteAll = useAppStore((s) => s.deleteAllConversations)
  const appVersion = useAppStore((s) => s.appVersion)
  const updaterStatus = useAppStore((s) => s.updaterStatus)
  const checkForUpdates = useAppStore((s) => s.checkForUpdates)
  const installUpdate = useAppStore((s) => s.installUpdate)

  const [name, setName] = useState(settings?.profileName ?? '')
  const [callMe, setCallMe] = useState(settings?.profileCallMe ?? '')
  const [instructions, setInstructions] = useState(settings?.customInstructions ?? '')

  if (!settings) return null

  // Persist on blur only when the value actually changed (matches the
  // draft-then-save pattern the other settings inputs use).
  const saveName = (): void => {
    if (name !== (settings.profileName ?? '')) void saveSettings({ profileName: name })
  }
  const saveCallMe = (): void => {
    if (callMe !== (settings.profileCallMe ?? '')) void saveSettings({ profileCallMe: callMe })
  }
  const saveInstructions = (): void => {
    if (instructions !== (settings.customInstructions ?? ''))
      void saveSettings({ customInstructions: instructions })
  }

  const statusLabel = (): string => {
    switch (updaterStatus.state) {
      case 'up-to-date':
        return updaterStatus.checkedAt
          ? `Up to date (checked ${new Date(updaterStatus.checkedAt).toLocaleTimeString()})`
          : 'Up to date'
      case 'dev-build':
        return 'Auto-update is unavailable in development builds'
      case 'downloading':
        return `Downloading BearCode ${updaterStatus.version ?? ''}…`
      case 'ready':
        return `Version ${updaterStatus.version ?? ''} downloaded`
      default:
        return ''
    }
  }

  return (
    <>
      <div className="page-title">General</div>
      <div className="page-sub">Your profile, custom instructions, and application data.</div>

      <div className="set-group-title">Profile</div>
      <div className="set-card">
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-title">Name</div>
            <div className="set-row-desc">Your name.</div>
          </div>
          <input
            type="text"
            className="set-input"
            placeholder="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
          />
        </div>
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-title">What should BearCode call you?</div>
            <div className="set-row-desc">How the assistant addresses you.</div>
          </div>
          <input
            type="text"
            className="set-input"
            placeholder="e.g. Ursa"
            value={callMe}
            onChange={(e) => setCallMe(e.target.value)}
            onBlur={saveCallMe}
          />
        </div>
      </div>

      <div className="set-group-title">Custom Instructions</div>
      <div className="set-card pad">
        <div className="set-row-desc" style={{ marginBottom: 8 }}>
          Standing instructions the assistant follows in every conversation.
        </div>
        <textarea
          className="set-textarea"
          rows={5}
          placeholder="e.g. Prefer TypeScript. Keep answers concise. Always run the tests before claiming done."
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          onBlur={saveInstructions}
        />
      </div>

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

      <div className="set-group-title">Software Update</div>
      <div className="set-card">
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-title">BearCode {appVersion ?? ''}</div>
            <div className="set-row-desc">
              {updaterStatus.state === 'checking' || updaterStatus.state === 'downloading' ? (
                <Loading label={statusLabel() || 'Checking…'} />
              ) : updaterStatus.state === 'error' ? (
                <ErrorCard>{updaterStatus.message}</ErrorCard>
              ) : (
                statusLabel()
              )}
            </div>
          </div>
          {updaterStatus.state === 'ready' ? (
            <button className="pill-btn primary" onClick={installUpdate}>
              Restart &amp; Install
            </button>
          ) : (
            <button
              className="pill-btn"
              onClick={() => void checkForUpdates()}
              disabled={updaterStatus.state === 'checking' || updaterStatus.state === 'downloading'}
            >
              Check for Updates
            </button>
          )}
        </div>
      </div>
    </>
  )
}
