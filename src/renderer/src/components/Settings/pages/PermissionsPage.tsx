import type { JSX } from 'react'
import type { FileAccessPolicy, SecurityPreset, TerminalAutoExec } from '@shared/types'
import { presetToSettings, settingsToPreset } from '@shared/securityPreset'
import { useAppStore } from '../../../state/store'
import { Select } from '../../Select'
import { PermissionRulesSection } from '../PermissionRules'

// A settings row: title + description on the left, the control on the right.
function Row({
  title,
  desc,
  children
}: {
  title: string
  desc: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="set-row">
      <div className="set-row-text">
        <div className="set-row-title">{title}</div>
        <div className="set-row-desc">{desc}</div>
      </div>
      {children}
    </div>
  )
}

export function PermissionsPage(): JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const saveSettings = useAppStore((s) => s.saveSettings)

  if (!settings) return null

  // The preset is DERIVED from the three primitives (single source of truth), so
  // the displayed preset can never drift from the settings it claims to describe.
  const preset = settingsToPreset(settings)
  const fileAccessPolicy = settings.fileAccessPolicy ?? 'deny'
  const terminalAutoExec = settings.terminalAutoExec ?? 'auto'

  // Picking a concrete preset applies its bundle; 'custom' is only ever a
  // display value (you reach it by editing an individual control).
  const pickPreset = (p: SecurityPreset): void => {
    if (p === 'custom') return
    const patch = presetToSettings(p)
    void saveSettings({ ...patch, securityPreset: p })
  }
  // Editing an individual control persists it AND re-derives the stored preset
  // mirror (flips to 'custom' unless the new combination still matches a preset).
  const setFileAccess = (v: FileAccessPolicy): void => {
    void saveSettings({
      fileAccessPolicy: v,
      securityPreset: settingsToPreset({ ...settings, fileAccessPolicy: v })
    })
  }
  const setTerminal = (v: TerminalAutoExec): void => {
    void saveSettings({
      terminalAutoExec: v,
      securityPreset: settingsToPreset({ ...settings, terminalAutoExec: v })
    })
  }
  const setDefaultMode = (v: 'ask' | 'accept-edits' | 'plan' | 'auto'): void => {
    void saveSettings({
      defaultPermissionMode: v,
      securityPreset: settingsToPreset({ ...settings, defaultPermissionMode: v })
    })
  }

  return (
    <>
      <div className="page-title">Permissions</div>
      <div className="page-sub">
        Global agent permissions. These apply everywhere unless a project overrides them.
      </div>

      <div className="set-group-title">Agent Settings</div>
      <div className="set-card">
        <Row
          title="Security Preset"
          desc="A named posture that bundles the controls below. Default asks before acting; Full Autonomy runs and reads freely. Editing any control switches this to Custom."
        >
          <Select
            ariaLabel="Security preset"
            value={preset}
            onChange={pickPreset}
            options={[
              {
                value: 'default',
                label: 'Default',
                description: 'Ask before edits, commands, and outside-folder reads'
              },
              {
                value: 'full-autonomy',
                label: 'Full Autonomy',
                description: 'Auto-run commands and allow outside-folder reads'
              },
              {
                value: 'custom',
                label: 'Custom',
                description: 'Your own mix of the controls below'
              }
            ]}
          />
        </Row>
        <Row
          title="File Access (outside the project folder)"
          desc="Reading files outside the project folder. Writes are always confined to the project folder. Grant a specific project broader access in its Project Settings."
        >
          <Select
            ariaLabel="File access policy"
            value={fileAccessPolicy}
            onChange={setFileAccess}
            options={[
              { value: 'deny', label: 'Blocked', description: 'Never read outside the folder' },
              { value: 'ask', label: 'Ask', description: 'Prompt before each outside read' },
              { value: 'allow', label: 'Allow reads', description: 'Read outside without asking' }
            ]}
          />
        </Row>
        <Row
          title="Terminal Command Auto-Execution"
          desc="Whether Auto mode runs shell commands without review. Require Review shows the approval card for each command even in Auto mode; deny rules and Plan mode still block regardless."
        >
          <Select
            ariaLabel="Terminal auto-execution"
            value={terminalAutoExec}
            onChange={setTerminal}
            options={[
              {
                value: 'require-review',
                label: 'Require review',
                description: 'Approve each command'
              },
              { value: 'auto', label: 'Auto', description: 'Auto mode runs commands' }
            ]}
          />
        </Row>
      </div>

      <PermissionRulesSection />

      <div className="set-group-title">Artifact Review</div>
      <div className="set-card">
        <Row
          title="Artifact Review Policy"
          desc="How the agent's submitted plans are handled. Request Review holds each plan for your review; Always Proceed approves it immediately. Applies to the next plan the agent submits."
        >
          <div className="radio-col" role="radiogroup" aria-label="Artifact review policy">
            <label className="radio-row">
              <input
                type="radio"
                name="artifact-review-policy"
                checked={settings.artifactReviewPolicy === 'request-review'}
                onChange={() => void saveSettings({ artifactReviewPolicy: 'request-review' })}
              />
              <span>Request Review (Recommended)</span>
            </label>
            <label className="radio-row">
              <input
                type="radio"
                name="artifact-review-policy"
                checked={settings.artifactReviewPolicy === 'always-proceed'}
                onChange={() => void saveSettings({ artifactReviewPolicy: 'always-proceed' })}
              />
              <span>Always Proceed</span>
            </label>
          </div>
        </Row>
      </div>

      <div className="set-group-title">Advanced</div>
      <div className="set-card">
        <Row
          title="Default Permission Mode"
          desc="The mode new conversations start in — the escape hatch behind the preset. Bypass is per-conversation only and can never be a default."
        >
          <Select
            ariaLabel="Default permission mode"
            value={settings.defaultPermissionMode}
            onChange={setDefaultMode}
            options={[
              { value: 'ask', label: 'Ask permissions' },
              { value: 'accept-edits', label: 'Accept edits' },
              { value: 'plan', label: 'Plan mode' },
              { value: 'auto', label: 'Auto mode' }
            ]}
          />
        </Row>
      </div>
    </>
  )
}
