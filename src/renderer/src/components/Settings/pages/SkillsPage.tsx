import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { SkillEntry, SkillInput } from '@shared/types'
import { useAppStore } from '../../../state/store'
import { Toggle } from '../../Toggle'
import { Select } from '../../Select'
import type { SelectOption } from '../../Select'
import { PluginBadge } from '../../PluginBadge'
import { BrowsePluginsModal } from '../BrowsePluginsModal'
import { EmptyState } from '../../ui/EmptyState'
import { Loading } from '../../ui/Loading'
import { FieldHint } from '../../ui/FieldHint'
import { isKebabName, KEBAB_HINT } from '../../../lib/validators'

const SCOPE_OPTIONS: SelectOption<'project' | 'global'>[] = [
  { value: 'project', label: 'Project' },
  { value: 'global', label: 'Global' }
]

type Draft = {
  originalName: string | null
  name: string
  description: string
  body: string
  scope: 'project' | 'global'
}

function emptyDraft(scope: 'project' | 'global'): Draft {
  return { originalName: null, name: '', description: '', body: '', scope }
}

function fmtSize(sizeBytes: number): string {
  if (sizeBytes >= 1024) return `${Math.round((sizeBytes / 1024) * 10) / 10} KB`
  return `${sizeBytes} B`
}

export function SkillsPage(): JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const workspacePath = useAppStore((s) => s.workspacePath)

  const [skills, setSkills] = useState<SkillEntry[] | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [pendingDelete, setPendingDelete] = useState<SkillEntry | null>(null)
  const [confirmText, setConfirmText] = useState('')
  const [browsing, setBrowsing] = useState(false)

  const refresh = (): void => {
    void window.bearcode.skills.list(workspacePath).then((list) => setSkills(list))
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath])

  if (!settings) return null

  const startCreate = (): void => {
    setDraft(emptyDraft(workspacePath ? 'project' : 'global'))
  }

  const startEdit = (entry: SkillEntry): void => {
    setDraft({
      originalName: entry.name,
      name: entry.name,
      description: entry.description,
      body: entry.body,
      scope: entry.source
    })
  }

  const submitDraft = (): void => {
    if (!draft) return
    const input: SkillInput = {
      name: draft.name.trim(),
      description: draft.description.trim(),
      body: draft.body,
      scope: draft.scope
    }
    const action = draft.originalName
      ? window.bearcode.skills.update(draft.originalName, input, workspacePath)
      : window.bearcode.skills.create(input, workspacePath)
    void action.then(() => {
      setDraft(null)
      refresh()
    })
  }

  const startDelete = (entry: SkillEntry): void => {
    setPendingDelete(entry)
    setConfirmText('')
  }

  const confirmDelete = (): void => {
    if (!pendingDelete) return
    void window.bearcode.skills
      .delete(pendingDelete.name, pendingDelete.source, workspacePath)
      .then(() => {
        setPendingDelete(null)
        setConfirmText('')
        refresh()
      })
  }

  const toggleEnabled = (entry: SkillEntry, on: boolean): void => {
    void window.bearcode.skills
      .setEnabled(entry.name, entry.source, workspacePath, on)
      .then(refresh)
  }

  const draftValid =
    !!draft && isKebabName(draft.name.trim()) && draft.description.trim().length > 0

  return (
    <>
      <div className="page-title">Skills</div>
      <div className="page-sub">
        Reusable workflows and domain knowledge the agent discovers by description and loads on
        demand.
      </div>
      <button className="pill-btn" onClick={() => setBrowsing(true)}>
        Browse Skills
      </button>

      <div className="set-group-title">Available skills</div>
      <div className="set-card">
        {skills === null ? (
          <div className="set-row">
            <Loading />
          </div>
        ) : skills.length === 0 ? (
          <div className="set-row">
            <EmptyState
              title="No skills yet"
              hint={
                <>
                  Create one below, or capture one from a conversation with <code>/learn</code>.
                </>
              }
            />
          </div>
        ) : (
          skills.map((entry) => (
            <div
              className="set-row"
              style={entry.error ? { opacity: 0.5 } : undefined}
              key={`${entry.source}:${entry.name}`}
            >
              <div className="set-row-text">
                <div className="set-row-title">
                  {entry.name}
                  <span className={'connector-badge' + (entry.source === 'global' ? '' : ' local')}>
                    {entry.source === 'global' ? 'Global' : 'Project'}
                  </span>
                  {entry.plugin ? <PluginBadge name={entry.plugin} /> : null}
                  <span className="set-row-desc"> · {fmtSize(entry.sizeBytes)}</span>
                </div>
                <div className="set-row-desc">
                  {entry.error ? `Error: ${entry.error}` : entry.description}
                </div>
                {pendingDelete &&
                pendingDelete.name === entry.name &&
                pendingDelete.source === entry.source ? (
                  <div className="skill-delete-confirm">
                    <span className="set-row-desc">
                      Type <strong>{entry.name}</strong> to confirm:
                    </span>
                    <input
                      className="set-input"
                      aria-label={`Type ${entry.name} to confirm`}
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                    />
                    <button
                      className="pill-btn primary"
                      disabled={confirmText !== entry.name}
                      onClick={confirmDelete}
                    >
                      Delete skill
                    </button>
                    <button className="pill-btn" onClick={() => setPendingDelete(null)}>
                      Cancel
                    </button>
                  </div>
                ) : null}
              </div>
              {!entry.error ? (
                <Toggle
                  ariaLabel={`Enable ${entry.name}`}
                  checked={entry.enabled}
                  onChange={(on) => toggleEnabled(entry, on)}
                />
              ) : null}
              <button
                className="pill-btn"
                disabled={!!entry.plugin}
                title={entry.plugin ? `Managed by the ${entry.plugin} plugin` : undefined}
                onClick={() => startEdit(entry)}
              >
                Edit
              </button>
              <button
                className="pill-btn"
                disabled={!!entry.plugin}
                title={entry.plugin ? `Managed by the ${entry.plugin} plugin` : undefined}
                onClick={() => startDelete(entry)}
              >
                Delete
              </button>
            </div>
          ))
        )}
      </div>

      {draft ? (
        <div className="set-card skill-add-card">
          <div className="skill-form">
            <div className="skill-field">
              <div className="set-row-title">Skill name</div>
              <input
                className="set-input"
                aria-label="Skill name"
                placeholder="e.g. run-our-tests"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
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
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
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
                placeholder={`Describe, in the imperative and third person, what this skill teaches the agent.`}
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              />
            </div>
            {workspacePath ? (
              <div className="skill-field">
                <div className="set-row-title">Scope</div>
                <Select
                  value={draft.scope}
                  options={SCOPE_OPTIONS}
                  onChange={(scope) => setDraft({ ...draft, scope })}
                  ariaLabel="Skill scope"
                />
              </div>
            ) : null}
            <div className="skill-form-actions">
              <button className="pill-btn" onClick={() => setDraft(null)}>
                Cancel
              </button>
              <button className="pill-btn primary" disabled={!draftValid} onClick={submitDraft}>
                {draft.originalName ? 'Save' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button className="pill-btn skill-new-btn" onClick={startCreate}>
          + New skill
        </button>
      )}

      {browsing ? (
        <BrowsePluginsModal
          mode="skills"
          onClose={() => setBrowsing(false)}
          onInstalled={() => {
            setBrowsing(false)
            refresh()
          }}
        />
      ) : null}
    </>
  )
}
