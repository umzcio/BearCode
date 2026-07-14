import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { SkillEntry, SkillInput } from '@shared/types'
import { useAppStore } from '../../../state/store'
import { BrowsePluginsModal } from '../BrowsePluginsModal'
import { EmptyState } from '../../ui/EmptyState'
import { Loading } from '../../ui/Loading'
import { useAnimatedUnmount } from '../../../lib/useAnimatedUnmount'
import { SkillEditForm, SkillRow, emptyDraft, type SkillDraft } from '../SkillEditForm'

export function SkillsPage(): JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const workspacePath = useAppStore((s) => s.workspacePath)

  const [skills, setSkills] = useState<SkillEntry[] | null>(null)
  const [draft, setDraft] = useState<SkillDraft | null>(null)
  const [pendingDelete, setPendingDelete] = useState<SkillEntry | null>(null)
  const [confirmText, setConfirmText] = useState('')
  const [browsing, setBrowsing] = useState(false)
  // BrowsePluginsModal owns no open/closed state of its own; keep it mounted
  // through its exit transition here.
  const { mounted: browseMounted, state: browseState } = useAnimatedUnmount(browsing)

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
            <SkillRow
              key={`${entry.source}:${entry.name}`}
              entry={entry}
              showSourceBadge={true}
              pendingDelete={
                pendingDelete?.name === entry.name && pendingDelete?.source === entry.source
              }
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
          showScopeSelector={workspacePath != null}
        />
      ) : (
        <button className="pill-btn skill-new-btn" onClick={startCreate}>
          + New skill
        </button>
      )}

      {browseMounted ? (
        <BrowsePluginsModal
          mode="skills"
          onClose={() => setBrowsing(false)}
          onInstalled={() => {
            setBrowsing(false)
            refresh()
          }}
          state={browseState}
        />
      ) : null}
    </>
  )
}
