import type { JSX } from 'react'
import type { SkillEntry } from '@shared/types'
import { Toggle } from '../Toggle'
import { Select } from '../Select'
import type { SelectOption } from '../Select'
import { PluginBadge } from '../PluginBadge'
import { FieldHint } from '../ui/FieldHint'
import { isKebabName, KEBAB_HINT } from '../../lib/validators'

export type SkillDraft = {
  originalName: string | null
  name: string
  description: string
  body: string
  scope: 'project' | 'global'
}

export function emptyDraft(scope: 'project' | 'global'): SkillDraft {
  return { originalName: null, name: '', description: '', body: '', scope }
}

export function fmtSize(sizeBytes: number): string {
  if (sizeBytes >= 1024) return `${Math.round((sizeBytes / 1024) * 10) / 10} KB`
  return `${sizeBytes} B`
}

export function isSkillDraftValid(draft: SkillDraft): boolean {
  return isKebabName(draft.name.trim()) && draft.description.trim().length > 0
}

const SCOPE_OPTIONS: SelectOption<'project' | 'global'>[] = [
  { value: 'project', label: 'Project' },
  { value: 'global', label: 'Global' }
]

// The skill create/edit form: shared by SkillsPage (global Settings, scope is
// a user choice when a workspace is open) and ProjectSkillsTab (per-project
// modal, scope is always 'project' and the selector is hidden).
export function SkillEditForm({
  draft,
  onChange,
  onSubmit,
  onCancel,
  showScopeSelector
}: {
  draft: SkillDraft
  onChange: (next: SkillDraft) => void
  onSubmit: () => void
  onCancel: () => void
  showScopeSelector: boolean
}): JSX.Element {
  const valid = isSkillDraftValid(draft)
  return (
    <div className="set-card skill-add-card">
      <div className="skill-form">
        <div className="skill-field">
          <div className="set-row-title">Skill name</div>
          <input
            className="set-input"
            aria-label="Skill name"
            placeholder="e.g. run-our-tests"
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
          />
          <FieldHint show={draft.name.trim().length > 0 && !isKebabName(draft.name.trim())}>
            {KEBAB_HINT}
          </FieldHint>
        </div>
        <div className="skill-field">
          <div className="set-row-title">Description</div>
          <input
            className="set-input"
            aria-label="Description"
            placeholder="One line: when should the agent reach for this skill?"
            value={draft.description}
            onChange={(e) => onChange({ ...draft, description: e.target.value })}
          />
          <FieldHint show={draft.description.trim().length === 0}>
            Description is required.
          </FieldHint>
        </div>
        <div className="skill-field">
          <div className="set-row-title">Body</div>
          <textarea
            className="set-textarea"
            aria-label="Body"
            rows={8}
            value={draft.body}
            placeholder="Describe, in the imperative and third person, what this skill teaches the agent."
            onChange={(e) => onChange({ ...draft, body: e.target.value })}
          />
        </div>
        {showScopeSelector ? (
          <div className="skill-field">
            <div className="set-row-title">Scope</div>
            <Select
              value={draft.scope}
              options={SCOPE_OPTIONS}
              onChange={(scope) => onChange({ ...draft, scope })}
              ariaLabel="Skill scope"
            />
          </div>
        ) : null}
        <div className="skill-form-actions">
          <button className="pill-btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="pill-btn primary" disabled={!valid} onClick={onSubmit}>
            {draft.originalName ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}

// One row in a skills list: name/badges/description/size, the delete-confirm
// inline prompt, an enable toggle, and Edit/Delete. Shared by SkillsPage
// (showSourceBadge=true, since it lists both scopes together) and
// ProjectSkillsTab (showSourceBadge=false, since every row IS a project skill).
export function SkillRow({
  entry,
  showSourceBadge,
  pendingDelete,
  confirmText,
  onConfirmTextChange,
  onToggleEnabled,
  onEdit,
  onStartDelete,
  onConfirmDelete,
  onCancelDelete
}: {
  entry: SkillEntry
  showSourceBadge: boolean
  pendingDelete: boolean
  confirmText: string
  onConfirmTextChange: (v: string) => void
  onToggleEnabled: (on: boolean) => void
  onEdit: () => void
  onStartDelete: () => void
  onConfirmDelete: () => void
  onCancelDelete: () => void
}): JSX.Element {
  return (
    <div className="set-row" style={entry.error ? { opacity: 0.5 } : undefined}>
      <div className="set-row-text">
        <div className="set-row-title">
          {entry.name}
          {showSourceBadge ? (
            <span className={'connector-badge' + (entry.source === 'global' ? '' : ' local')}>
              {entry.source === 'global' ? 'Global' : 'Project'}
            </span>
          ) : null}
          {entry.plugin ? <PluginBadge name={entry.plugin} /> : null}
          <span className="set-row-desc"> · {fmtSize(entry.sizeBytes)}</span>
        </div>
        <div className="set-row-desc">{entry.error ? `Error: ${entry.error}` : entry.description}</div>
        {pendingDelete ? (
          <div className="skill-delete-confirm">
            <span className="set-row-desc">
              Type <strong>{entry.name}</strong> to confirm:
            </span>
            <input
              className="set-input"
              aria-label={`Type ${entry.name} to confirm`}
              value={confirmText}
              onChange={(e) => onConfirmTextChange(e.target.value)}
            />
            <button
              className="pill-btn primary"
              disabled={confirmText !== entry.name}
              onClick={onConfirmDelete}
            >
              Delete skill
            </button>
            <button className="pill-btn" onClick={onCancelDelete}>
              Cancel
            </button>
          </div>
        ) : null}
      </div>
      {!entry.error ? (
        <Toggle ariaLabel={`Enable ${entry.name}`} checked={entry.enabled} onChange={onToggleEnabled} />
      ) : null}
      <button
        className="pill-btn"
        disabled={!!entry.plugin}
        title={entry.plugin ? `Managed by the ${entry.plugin} plugin` : undefined}
        onClick={onEdit}
      >
        Edit
      </button>
      <button
        className="pill-btn"
        disabled={!!entry.plugin}
        title={entry.plugin ? `Managed by the ${entry.plugin} plugin` : undefined}
        onClick={onStartDelete}
      >
        Delete
      </button>
    </div>
  )
}
