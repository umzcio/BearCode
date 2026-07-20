import type { JSX } from 'react'
import { useAppStore } from '../../../state/store'
import { Select } from '../../Select'

export function VoicePage(): JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const saveSettings = useAppStore((s) => s.saveSettings)

  if (!settings) return null

  return (
    <>
      <div className="page-title">Voice</div>
      <div className="page-sub">Speech-to-text for the composer&apos;s voice input.</div>

      <div className="set-group-title">Voice input</div>
      <div className="set-card">
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-title">Speech-to-text backend</div>
            <div className="set-row-desc">
              OpenAI Whisper transcribes in the cloud using your OpenAI key. Local runs on-device,
              offline, with no key.
            </div>
          </div>
          <Select
            ariaLabel="Speech-to-text backend"
            value={settings.sttBackend ?? 'openai'}
            onChange={(v) => void saveSettings({ sttBackend: v })}
            options={[
              { value: 'openai', label: 'OpenAI Whisper (uses your OpenAI key)' },
              { value: 'local', label: 'Local (offline)' }
            ]}
          />
        </div>
      </div>
    </>
  )
}
