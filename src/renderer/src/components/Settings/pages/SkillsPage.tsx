import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { SkillEntry, SkillInput } from '@shared/types'
import { useAppStore } from '../../../state/store'
import { Toggle } from '../../Toggle'
import { Select } from '../../Select'
import type { SelectOption } from '../../Select'

const KEBAB_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

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
      body: '',
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
    !!draft && KEBAB_PATTERN.test(draft.name.trim()) && draft.description.trim().length > 0

  return (
    <>
      <div className="page-title">Skills</div>
      <div className="page-sub">
        Reusable workflows and domain knowledge the agent discovers by description and loads on
        demand.
      </div>

      <div className="set-group-title">Available skills</div>
      <div className="set-card">
        {skills === null ? (
          <div className="set-row-desc">Loading…</div>
        ) : skills.length === 0 ? (
          <div className="set-row-desc">No skills yet.</div>
        ) : (
          skills.map((entry) => (
            <div className="set-row" key={`${entry.source}:${entry.name}`}>
              <div className="set-row-text">
                <div className="set-row-title">
                  {entry.name}
                  <span className={'connector-badge' + (entry.source === 'global' ? '' : ' local')}>
                    {entry.source === 'global' ? 'Global' : 'Project'}
                  </span>
                  <span className="set-row-desc"> · {fmtSize(entry.sizeBytes)}</span>
                </div>
                <div className="set-row-desc">
                  {entry.error ? `Error: ${entry.error}` : entry.description}
                </div>
              </div>
              {!entry.error ? (
                <Toggle
                  ariaLabel={`Enable ${entry.name}`}
                  checked={entry.enabled}
                  onChange={(on) => toggleEnabled(entry, on)}
                />
              ) : null}
              <button className="pill-btn" onClick={() => startEdit(entry)}>
                Edit
              </button>
              <button className="pill-btn" onClick={() => startDelete(entry)}>
                Delete
              </button>
              {pendingDelete && pendingDelete.name === entry.name ? (
                <div className="set-row">
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
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>

      {draft ? (
        <div className="set-card connector-add-form">
          <label className="set-row-text">
            <div className="set-row-title">Skill name</div>
            <input
              className="set-input"
              aria-label="Skill name"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label className="set-row-text">
            <div className="set-row-title">Description</div>
            <input
              className="set-input"
              aria-label="Description"
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </label>
          <label className="set-row-text">
            <div className="set-row-title">Body</div>
            <textarea
              aria-label="Body"
              value={draft.body}
              placeholder={`Describe here, in the imperative and third person, what this skill teaches the agent.`}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
          </label>
          {workspacePath ? (
            <Select
              value={draft.scope}
              options={SCOPE_OPTIONS}
              onChange={(scope) => setDraft({ ...draft, scope })}
              ariaLabel="Skill scope"
            />
          ) : null}
          <button className="pill-btn primary" disabled={!draftValid} onClick={submitDraft}>
            {draft.originalName ? 'Save' : 'Create'}
          </button>
          <button className="pill-btn" onClick={() => setDraft(null)}>
            Cancel
          </button>
        </div>
      ) : (
        <button className="pill-btn" onClick={startCreate}>
          + New skill
        </button>
      )}
    </>
  )
}
