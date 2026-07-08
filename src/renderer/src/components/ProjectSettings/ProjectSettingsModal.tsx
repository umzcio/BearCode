import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { EffortLevel, FolderProject, PermissionMode } from '@shared/types'
import { EFFORT_LEVELS, EFFORT_LABELS } from '@shared/effort'
import { useAppStore } from '../../state/store'
import { Select } from '../Select'
import { SettingPlaceholder } from '../Settings/SettingPlaceholder'
import { IconClose, IconGear, IconPalette, IconBrain, IconPlug, IconBlocks } from '../icons'
import { PROJECT_ICONS } from './projectIcons'
import '../Settings/Settings.css'
import './ProjectSettings.css'

// Curated project colors (bounded, like the icon set — no arbitrary picker).
const PROJECT_COLORS = ['#d97757', '#4c8dff', '#3ecf8e', '#e0b568', '#b58cff', '#e5698f', '#5ac8d8']

type PageId = 'general' | 'appearance' | 'defaults' | 'connectors' | 'skills'

const PS_NAV: { id: PageId; label: string; icon: (p: { size?: number }) => JSX.Element }[] = [
  { id: 'general', label: 'General', icon: IconGear },
  { id: 'appearance', label: 'Appearance', icon: IconPalette },
  { id: 'defaults', label: 'Defaults', icon: IconBrain },
  { id: 'connectors', label: 'Connectors', icon: IconPlug },
  { id: 'skills', label: 'Skills', icon: IconBlocks }
]

function basename(path: string): string {
  const parts = path.replace(/\/$/, '').split('/')
  return parts[parts.length - 1] || path
}

// Outer gate: mounted unconditionally in App; renders the panel (keyed by folder
// path so its local draft state initializes fresh) only when open. A folder with
// no stored settings row resolves to an all-null FolderProject so the modal can
// open on any folder; the first edit upserts the row.
export function ProjectSettingsModal(): JSX.Element | null {
  const path = useAppStore((s) => s.projectSettingsPath)
  const stored = useAppStore((s) =>
    path ? (s.folderSettings.find((f) => f.path === path) ?? null) : null
  )
  if (!path) return null
  const folder: FolderProject = stored ?? {
    path,
    name: null,
    color: null,
    icon: null,
    defaultModelRef: null,
    defaultEffort: null,
    defaultPermissionMode: null
  }
  return <ProjectSettingsPanel key={folder.path} folder={folder} />
}

function ProjectSettingsPanel({ folder }: { folder: FolderProject }): JSX.Element {
  const providers = useAppStore((s) => s.providers)
  const close = useAppStore((s) => s.closeProjectSettings)
  const updateProject = useAppStore((s) => s.updateProject)
  const setAsNewProjectDefault = useAppStore((s) => s.setAsNewProjectDefault)

  const [page, setPage] = useState<PageId>('general')
  const folderName = basename(folder.path)
  const displayName = folder.name ?? folderName
  const [name, setName] = useState(folder.name ?? '')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  const modelOptions = [
    { value: '', label: 'Inherit global default' },
    ...providers.flatMap((p) =>
      p.models.map((m) => ({ value: `${p.id}/${m.id}`, label: `${p.displayName}: ${m.label}` }))
    )
  ]
  const effortOptions = [
    { value: '', label: 'Inherit global default' },
    ...EFFORT_LEVELS.map((l) => ({ value: l, label: EFFORT_LABELS[l] }))
  ]
  const modeOptions: { value: string; label: string }[] = [
    { value: '', label: 'Inherit global default' },
    { value: 'ask', label: 'Ask permissions' },
    { value: 'accept-edits', label: 'Accept edits' },
    { value: 'plan', label: 'Plan mode' },
    { value: 'auto', label: 'Auto mode' }
  ]

  // A custom display name; blank clears the override back to the folder basename.
  const saveName = (): void => {
    const n = name.trim()
    if ((n || null) !== (folder.name ?? null)) void updateProject(folder.path, { name: n || null })
  }

  return (
    <div className="modal-overlay open" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="settings-panel">
        <div className="settings-rail">
          <div className="rail-group">
            <div className="rail-group-label">{displayName}</div>
            {PS_NAV.map((item) => {
              const Icon = item.icon
              return (
                <button
                  key={item.id}
                  className={'rail-item' + (page === item.id ? ' selected' : '')}
                  onClick={() => setPage(item.id)}
                >
                  <Icon size={16} />
                  <span>{item.label}</span>
                </button>
              )
            })}
          </div>
        </div>

        <div className="settings-content">
          <button className="content-close" title="Close" onClick={close}>
            <IconClose />
          </button>

          {page === 'general' ? (
            <>
              <div className="page-title">General</div>
              <div className="page-sub">
                Per-folder settings for <b>{displayName}</b>. Unset defaults inherit the global
                settings.
              </div>

              <div className="set-group-title">Name</div>
              <div className="set-card pad">
                <input
                  className="set-input"
                  aria-label="Project name"
                  placeholder={folderName}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={saveName}
                />
                <div className="set-row-desc" style={{ marginTop: 8 }}>
                  A display name for this folder. Leave blank to use the folder name (
                  <b>{folderName}</b>).
                </div>
              </div>

              <div className="set-group-title">Template</div>
              <div className="set-card pad ps-default-row">
                <div className="set-row-text">
                  <div className="set-row-title">Set as default for new folders</div>
                  <div className="set-row-desc">
                    Apply this folder&apos;s color, icon, and defaults to every folder you open
                    next.
                  </div>
                </div>
                <button
                  className="pill-btn"
                  onClick={() =>
                    void setAsNewProjectDefault({
                      color: folder.color,
                      icon: folder.icon,
                      defaultModelRef: folder.defaultModelRef,
                      defaultEffort: folder.defaultEffort,
                      defaultPermissionMode: folder.defaultPermissionMode
                    })
                  }
                >
                  Set as default
                </button>
              </div>
            </>
          ) : null}

          {page === 'appearance' ? (
            <>
              <div className="page-title">Appearance</div>
              <div className="page-sub">
                A color and icon to recognize this folder in the sidebar.
              </div>

              <div className="set-group-title">Color</div>
              <div className="set-card pad">
                <div className="ps-swatches">
                  <button
                    className={'ps-swatch none' + (folder.color == null ? ' selected' : '')}
                    aria-label="No color"
                    onClick={() => void updateProject(folder.path, { color: null })}
                  />
                  {PROJECT_COLORS.map((col) => (
                    <button
                      key={col}
                      className={'ps-swatch' + (folder.color === col ? ' selected' : '')}
                      style={{ background: col }}
                      aria-label={`Color ${col}`}
                      onClick={() => void updateProject(folder.path, { color: col })}
                    />
                  ))}
                </div>
              </div>

              <div className="set-group-title">Icon</div>
              <div className="set-card pad">
                <div className="ps-icons">
                  {Object.entries(PROJECT_ICONS).map(([iconName, Icon]) => (
                    <button
                      key={iconName}
                      className={'ps-icon' + (folder.icon === iconName ? ' selected' : '')}
                      aria-label={iconName}
                      onClick={() => void updateProject(folder.path, { icon: iconName })}
                    >
                      <Icon size={16} />
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : null}

          {page === 'defaults' ? (
            <>
              <div className="page-title">Defaults for new conversations</div>
              <div className="page-sub">
                What conversations started in this folder begin with. Each inherits the global
                default when left unset.
              </div>
              <div className="set-card">
                <div className="set-row">
                  <div className="set-row-text">
                    <div className="set-row-title">Model</div>
                    <div className="set-row-desc">
                      The model conversations in this folder start with.
                    </div>
                  </div>
                  <Select
                    ariaLabel="Project default model"
                    value={folder.defaultModelRef ?? ''}
                    onChange={(v) =>
                      void updateProject(folder.path, { defaultModelRef: v || null })
                    }
                    options={modelOptions}
                  />
                </div>
                <div className="set-row">
                  <div className="set-row-text">
                    <div className="set-row-title">Effort</div>
                    <div className="set-row-desc">Reasoning effort for new conversations.</div>
                  </div>
                  <Select
                    ariaLabel="Project default effort"
                    value={folder.defaultEffort ?? ''}
                    onChange={(v) =>
                      void updateProject(folder.path, {
                        defaultEffort: (v || null) as EffortLevel | null
                      })
                    }
                    options={effortOptions}
                  />
                </div>
                <div className="set-row">
                  <div className="set-row-text">
                    <div className="set-row-title">Permission Mode</div>
                    <div className="set-row-desc">
                      The permission mode new conversations start in (overrides the global default).
                    </div>
                  </div>
                  <Select
                    ariaLabel="Project default permission mode"
                    value={folder.defaultPermissionMode ?? ''}
                    onChange={(v) =>
                      void updateProject(folder.path, {
                        defaultPermissionMode: (v || null) as PermissionMode | null
                      })
                    }
                    options={modeOptions}
                  />
                </div>
              </div>
            </>
          ) : null}

          {page === 'connectors' ? (
            <>
              <div className="page-title">Connectors</div>
              <div className="page-sub">MCP servers and tools scoped to this folder.</div>
              <SettingPlaceholder
                title="Project Connectors"
                description="Per-project MCP servers and tools the agent can call — arriving in a future update."
              />
            </>
          ) : null}

          {page === 'skills' ? (
            <>
              <div className="page-title">Skills</div>
              <div className="page-sub">Reusable workflows scoped to this folder.</div>
              <SettingPlaceholder
                title="Project Skills"
                description="Reusable workflows scoped to this project — arriving in a future update."
              />
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}
