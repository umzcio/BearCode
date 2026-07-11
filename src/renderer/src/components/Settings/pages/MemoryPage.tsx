import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type {
  MemoryEntry,
  MemoryList,
  MemoryScopeName,
  MemoryScope as MemoryScopeData,
  PromoteTarget
} from '@shared/types'
import { useAppStore } from '../../../state/store'
import { Select } from '../../Select'
import type { SelectOption } from '../../Select'

const KEBAB_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

const PROMOTE_OPTIONS: SelectOption<PromoteTarget>[] = [
  { value: 'rule', label: 'Rule' },
  { value: 'skill', label: 'Skill' }
]

type EditDraft = { scope: MemoryScopeName; index: number; text: string }
type PromoteDraft = {
  scope: MemoryScopeName
  index: number
  target: PromoteTarget
  name: string
  description: string
}

function fmtSize(sizeBytes: number): string {
  if (sizeBytes >= 1024) return `${Math.round((sizeBytes / 1024) * 10) / 10} KB`
  return `${sizeBytes} B`
}

export function MemoryPage(): JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const workspacePath = useAppStore((s) => s.workspacePath)

  const [list, setList] = useState<MemoryList | null>(null)
  const [addDraft, setAddDraft] = useState<{ scope: MemoryScopeName; text: string } | null>(null)
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null)
  const [promoteDraft, setPromoteDraft] = useState<PromoteDraft | null>(null)
  const [fullNotice, setFullNotice] = useState<MemoryScopeName | null>(null)

  const refresh = (): void => {
    void window.bearcode.memory.list(workspacePath).then((l) => setList(l))
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath])

  if (!settings) return null

  const startAdd = (scope: MemoryScopeName): void => {
    setAddDraft({ scope, text: '' })
    setFullNotice(null)
  }

  const submitAdd = (): void => {
    if (!addDraft) return
    const text = addDraft.text.trim()
    if (!text) return
    void window.bearcode.memory.add(addDraft.scope, text, workspacePath).then((result) => {
      if (result === 'full') {
        setFullNotice(addDraft.scope)
        return
      }
      setAddDraft(null)
      setFullNotice(null)
      refresh()
    })
  }

  const startEdit = (entry: MemoryEntry): void => {
    setEditDraft({ scope: entry.scope, index: entry.index, text: entry.text })
  }

  const submitEdit = (): void => {
    if (!editDraft) return
    void window.bearcode.memory
      .update(editDraft.scope, editDraft.index, editDraft.text, workspacePath)
      .then(() => {
        setEditDraft(null)
        refresh()
      })
  }

  const deleteEntry = (entry: MemoryEntry): void => {
    void window.bearcode.memory.delete(entry.scope, entry.index, workspacePath).then(() => {
      refresh()
    })
  }

  const startPromote = (entry: MemoryEntry): void => {
    setPromoteDraft({
      scope: entry.scope,
      index: entry.index,
      target: 'rule',
      name: '',
      description: ''
    })
  }

  const submitPromote = (): void => {
    if (!promoteDraft) return
    const name = promoteDraft.name.trim()
    if (!KEBAB_PATTERN.test(name)) return
    if (promoteDraft.target === 'skill' && !promoteDraft.description.trim()) return
    void window.bearcode.memory
      .promote(
        {
          scope: promoteDraft.scope,
          index: promoteDraft.index,
          target: promoteDraft.target,
          name,
          description: promoteDraft.target === 'skill' ? promoteDraft.description.trim() : undefined
        },
        workspacePath
      )
      .then(() => {
        setPromoteDraft(null)
        refresh()
      })
  }

  const promoteValid =
    !!promoteDraft &&
    KEBAB_PATTERN.test(promoteDraft.name.trim()) &&
    (promoteDraft.target !== 'skill' || promoteDraft.description.trim().length > 0)

  const renderScope = (scopeName: MemoryScopeName, data: MemoryScopeData): JSX.Element => (
    <div key={scopeName}>
      <div className="set-group-title">
        {scopeName === 'global' ? 'Global' : 'Project'} · {fmtSize(data.sizeBytes)}
      </div>
      <div className="set-card">
        {data.entries.length === 0 ? (
          <div className="set-row">
            <div className="set-row-desc">No memory yet.</div>
          </div>
        ) : (
          data.entries.map((entry) => (
            <div className="set-row" key={`${entry.scope}:${entry.index}`}>
              <div className="set-row-text">
                {editDraft && editDraft.scope === entry.scope && editDraft.index === entry.index ? (
                  <>
                    <input
                      className="set-input"
                      aria-label="Edit memory"
                      value={editDraft.text}
                      onChange={(e) => setEditDraft({ ...editDraft, text: e.target.value })}
                    />
                    <div className="skill-form-actions">
                      <button className="pill-btn" onClick={() => setEditDraft(null)}>
                        Cancel
                      </button>
                      <button className="pill-btn primary" onClick={submitEdit}>
                        Save
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="set-row-desc">{entry.text}</div>
                )}
                {promoteDraft &&
                promoteDraft.scope === entry.scope &&
                promoteDraft.index === entry.index ? (
                  <div className="skill-form">
                    <div className="skill-field">
                      <div className="set-row-title">Promote to</div>
                      <Select
                        value={promoteDraft.target}
                        options={PROMOTE_OPTIONS}
                        onChange={(target) => setPromoteDraft({ ...promoteDraft, target })}
                        ariaLabel="Promote target"
                      />
                    </div>
                    <div className="skill-field">
                      <div className="set-row-title">Name</div>
                      <input
                        className="set-input"
                        aria-label="Promote name"
                        placeholder="e.g. our-test-runner"
                        value={promoteDraft.name}
                        onChange={(e) => setPromoteDraft({ ...promoteDraft, name: e.target.value })}
                      />
                    </div>
                    {promoteDraft.target === 'skill' ? (
                      <div className="skill-field">
                        <div className="set-row-title">Description</div>
                        <input
                          className="set-input"
                          aria-label="Promote description"
                          value={promoteDraft.description}
                          onChange={(e) =>
                            setPromoteDraft({ ...promoteDraft, description: e.target.value })
                          }
                        />
                      </div>
                    ) : null}
                    <div className="skill-form-actions">
                      <button className="pill-btn" onClick={() => setPromoteDraft(null)}>
                        Cancel
                      </button>
                      <button
                        className="pill-btn primary"
                        disabled={!promoteValid}
                        onClick={submitPromote}
                      >
                        Promote
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
              <button className="pill-btn" onClick={() => startEdit(entry)}>
                Edit
              </button>
              <button className="pill-btn" onClick={() => startPromote(entry)}>
                Promote ▾
              </button>
              <button className="pill-btn" onClick={() => deleteEntry(entry)}>
                Delete
              </button>
            </div>
          ))
        )}
      </div>

      {addDraft && addDraft.scope === scopeName ? (
        <div className="set-card skill-add-card">
          <div className="skill-form">
            <div className="skill-field">
              <div className="set-row-title">New memory</div>
              <input
                className="set-input"
                aria-label="New memory"
                placeholder="A durable fact worth remembering"
                value={addDraft.text}
                onChange={(e) => setAddDraft({ ...addDraft, text: e.target.value })}
              />
            </div>
            {fullNotice === scopeName ? (
              <div className="set-row-desc">Memory full — prune entries</div>
            ) : null}
            <div className="skill-form-actions">
              <button className="pill-btn" onClick={() => setAddDraft(null)}>
                Cancel
              </button>
              <button
                className="pill-btn primary"
                disabled={!addDraft.text.trim()}
                onClick={submitAdd}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button className="pill-btn skill-new-btn" onClick={() => startAdd(scopeName)}>
          + Add memory
        </button>
      )}
    </div>
  )

  return (
    <>
      <div className="page-title">Memory</div>
      <div className="page-sub">
        Durable facts the agent remembers across sessions — pulled into every turn.
      </div>

      {list ? renderScope('global', list.global) : null}
      {list && workspacePath ? renderScope('project', list.project) : null}
    </>
  )
}
