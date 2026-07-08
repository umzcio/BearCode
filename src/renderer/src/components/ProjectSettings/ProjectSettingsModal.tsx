import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { EffortLevel, PermissionMode, Project } from '@shared/types'
import { EFFORT_LEVELS, EFFORT_LABELS } from '@shared/effort'
import { useAppStore } from '../../state/store'
import { Select } from '../Select'
import { SettingPlaceholder } from '../Settings/SettingPlaceholder'
import { IconClose } from '../icons'
import { PROJECT_ICONS } from './projectIcons'
import './ProjectSettings.css'

// Curated project colors (bounded, like the icon set — no arbitrary picker).
const PROJECT_COLORS = ['#d97757', '#4c8dff', '#3ecf8e', '#e0b568', '#b58cff', '#e5698f', '#5ac8d8']

// Outer gate: mounted unconditionally in App; renders the panel (keyed by
// project id so its local draft state initializes fresh) only when open.
export function ProjectSettingsModal(): JSX.Element | null {
  const projectId = useAppStore((s) => s.projectSettingsId)
  const project = useAppStore((s) => s.projects.find((p) => p.id === projectId) ?? null)
  if (!projectId || !project) return null
  return <ProjectSettingsPanel key={project.id} project={project} />
}

function ProjectSettingsPanel({ project }: { project: Project }): JSX.Element {
  const providers = useAppStore((s) => s.providers)
  const close = useAppStore((s) => s.closeProjectSettings)
  const updateProject = useAppStore((s) => s.updateProject)
  const renameProject = useAppStore((s) => s.renameProject)
  const setAsNewProjectDefault = useAppStore((s) => s.setAsNewProjectDefault)

  const [name, setName] = useState(project.name)

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

  const saveName = (): void => {
    const n = name.trim()
    if (n && n !== project.name) void renameProject(project.id, n)
  }

  return (
    <div className="modal-overlay open" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="project-settings-panel">
        <button className="content-close" title="Close" onClick={close}>
          <IconClose />
        </button>
        <div className="page-title">Project Settings</div>
        <div className="page-sub">
          Appearance and per-project defaults for <b>{project.name}</b>. Unset defaults inherit the
          global settings.
        </div>

        <div className="set-group-title">Name</div>
        <div className="set-card pad">
          <input
            className="set-input"
            aria-label="Project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
          />
        </div>

        <div className="set-group-title">Appearance</div>
        <div className="set-card pad">
          <div className="set-row-title">Color</div>
          <div className="ps-swatches">
            <button
              className={'ps-swatch none' + (project.color == null ? ' selected' : '')}
              aria-label="No color"
              onClick={() => void updateProject(project.id, { color: null })}
            />
            {PROJECT_COLORS.map((c) => (
              <button
                key={c}
                className={'ps-swatch' + (project.color === c ? ' selected' : '')}
                style={{ background: c }}
                aria-label={`Color ${c}`}
                onClick={() => void updateProject(project.id, { color: c })}
              />
            ))}
          </div>
          <div className="set-row-title" style={{ marginTop: 12 }}>
            Icon
          </div>
          <div className="ps-icons">
            {Object.entries(PROJECT_ICONS).map(([iconName, Icon]) => (
              <button
                key={iconName}
                className={'ps-icon' + (project.icon === iconName ? ' selected' : '')}
                aria-label={iconName}
                onClick={() => void updateProject(project.id, { icon: iconName })}
              >
                <Icon size={16} />
              </button>
            ))}
          </div>
        </div>

        <div className="set-group-title">Defaults for new conversations</div>
        <div className="set-card">
          <div className="set-row">
            <div className="set-row-text">
              <div className="set-row-title">Model</div>
              <div className="set-row-desc">
                The model conversations in this project start with.
              </div>
            </div>
            <Select
              ariaLabel="Project default model"
              value={project.defaultModelRef ?? ''}
              onChange={(v) => void updateProject(project.id, { defaultModelRef: v || null })}
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
              value={project.defaultEffort ?? ''}
              onChange={(v) =>
                void updateProject(project.id, { defaultEffort: (v || null) as EffortLevel | null })
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
              value={project.defaultPermissionMode ?? ''}
              onChange={(v) =>
                void updateProject(project.id, {
                  defaultPermissionMode: (v || null) as PermissionMode | null
                })
              }
              options={modeOptions}
            />
          </div>
        </div>

        <div className="set-group-title">Connectors</div>
        <SettingPlaceholder
          title="Project Connectors"
          description="Per-project MCP servers and tools the agent can call — arriving in a future update."
        />
        <div className="set-group-title">Skills</div>
        <SettingPlaceholder
          title="Project Skills"
          description="Reusable workflows scoped to this project — arriving in a future update."
        />

        <div className="set-card pad ps-default-row">
          <div className="set-row-text">
            <div className="set-row-title">Set as default for new projects</div>
            <div className="set-row-desc">
              Apply this project&apos;s color, icon, and defaults to every project you create next.
            </div>
          </div>
          <button
            className="pill-btn"
            onClick={() =>
              void setAsNewProjectDefault({
                color: project.color,
                icon: project.icon ?? null,
                defaultModelRef: project.defaultModelRef ?? null,
                defaultEffort: project.defaultEffort ?? null,
                defaultPermissionMode: project.defaultPermissionMode ?? null
              })
            }
          >
            Set as default
          </button>
        </div>
      </div>
    </div>
  )
}
