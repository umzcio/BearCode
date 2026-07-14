import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { SkillEntry, SkillInput } from '@shared/types'
import { EmptyState } from '../ui/EmptyState'
import { Loading } from '../ui/Loading'
import { SkillEditForm, SkillRow, emptyDraft } from '../Settings/SkillEditForm'
import type { SkillDraft } from '../Settings/SkillEditForm'

// Project-scoped skill management for the per-project Settings modal (a
// project the user may not currently have open as their active workspace).
// Pure filesystem CRUD under <project>/.agents/skills -- no live-connection
// concerns, unlike ProjectConnectorsTab. See planning/2026-07-14-project-
// connectors-skills-design.md.
export function ProjectSkillsTab({ projectPath }: { projectPath: string }): JSX.Element {
  const [skills, setSkills] = useState<SkillEntry[] | null>(null)
  const [draft, setDraft] = useState<SkillDraft | null>(null)
  const [pendingDelete, setPendingDelete] = useState<SkillEntry | null>(null)
  const [confirmText, setConfirmText] = useState('')

  const refresh = (): void => {
    void window.bearcode.skills.list(projectPath).then((list) => setSkills(list))
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath])

  const projectSkills = (skills ?? []).filter((s) => s.source === 'project')

  const startCreate = (): void => setDraft(emptyDraft('project'))

  const startEdit = (entry: SkillEntry): void => {
    setDraft({
      originalName: entry.name,
      name: entry.name,
      description: entry.description,
      body: entry.body,
      scope: 'project'
    })
  }

  const submitDraft = (): void => {
    if (!draft) return
    const input: SkillInput = {
      name: draft.name.trim(),
      description: draft.description.trim(),
      body: draft.body,
      scope: 'project'
    }
    const action = draft.originalName
      ? window.bearcode.skills.update(draft.originalName, input, projectPath)
      : window.bearcode.skills.create(input, projectPath)
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
    void window.bearcode.skills.delete(pendingDelete.name, 'project', projectPath).then(() => {
      setPendingDelete(null)
      setConfirmText('')
      refresh()
    })
  }

  const toggleEnabled = (entry: SkillEntry, on: boolean): void => {
    void window.bearcode.skills.setEnabled(entry.name, 'project', projectPath, on).then(refresh)
  }

  return (
    <>
      <div className="page-title">Skills</div>
      <div className="page-sub">Reusable workflows and domain knowledge scoped to this project.</div>

      <div className="set-group-title">Available skills</div>
      <div className="set-card">
        {skills === null ? (
          <div className="set-row">
            <Loading />
          </div>
        ) : projectSkills.length === 0 ? (
          <div className="set-row">
            <EmptyState title="No skills yet" hint="Create one below." />
          </div>
        ) : (
          projectSkills.map((entry) => (
            <SkillRow
              key={entry.name}
              entry={entry}
              showSourceBadge={false}
              pendingDelete={pendingDelete?.name === entry.name}
              confirmText={confirmText}
              onConfirmTextChange={setConfirmText}
              onToggleEnabled={(on) => toggleEnabled(entry, on)}
              onEdit={() => startEdit(entry)}
              onStartDelete={() => startDelete(entry)}
              onConfirmDelete={confirmDelete}
              onCancelDelete={() => setPendingDelete(null)}
            />
          ))
        )}
      </div>

      {draft ? (
        <SkillEditForm
          draft={draft}
          onChange={setDraft}
          onSubmit={submitDraft}
          onCancel={() => setDraft(null)}
          showScopeSelector={false}
        />
      ) : (
        <button className="pill-btn skill-new-btn" onClick={startCreate}>
          + New skill
        </button>
      )}
    </>
  )
}
