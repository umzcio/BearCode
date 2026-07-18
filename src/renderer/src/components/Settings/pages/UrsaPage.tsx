import { useState } from 'react'
import type { JSX } from 'react'
import type { UrsaRole } from '@shared/types'
import { useAppStore } from '../../../state/store'
import { Select, type SelectOption } from '../../Select'
import { FieldHint } from '../../ui/FieldHint'

function modelRefOptions(
  providers: ReturnType<typeof useAppStore.getState>['providers']
): SelectOption<string>[] {
  return providers
    .filter((p) => p.reachable && (!p.requiresKey || p.keyConfigured))
    .flatMap((p) => p.models.map((m) => ({ value: `${p.id}/${m.id}`, label: `${p.displayName} — ${m.label}` })))
}

// Settings > Ursa: CRUD for the named roles Ursa's classifier dispatches
// turns to. Follows GeneralPage's draft-then-save-on-blur pattern; model
// selection reuses the shared Select (never a native <select>, per CLAUDE.md).
export function UrsaPage(): JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const providers = useAppStore((s) => s.providers)
  const saveSettings = useAppStore((s) => s.saveSettings)
  const [draft, setDraft] = useState<UrsaRole[] | null>(null)

  if (!settings) return null
  const roles = draft ?? settings.ursaRoles

  const commit = (next: UrsaRole[]): void => {
    setDraft(next)
    const allNamed = next.every((r) => r.name.trim().length > 0)
    const names = next.map((r) => r.name.trim())
    const hasDupe = new Set(names).size !== names.length
    if (allNamed && !hasDupe) void saveSettings({ ursaRoles: next }).then(() => setDraft(null))
  }

  // Flags only the later occurrence(s) of a repeated name, not the original
  // row, so the hint doesn't double up on every row sharing that name.
  const duplicateAt = (index: number): boolean => {
    const name = roles[index].name.trim()
    if (!name) return false
    return roles.some((r, j) => j < index && r.name.trim() === name)
  }

  const options = modelRefOptions(providers)

  return (
    <>
      <div className="page-title">Ursa</div>
      <div className="page-sub">
        Named roles Ursa routes turns to automatically. Select "Ursa" in the model picker to
        activate dynamic routing.
      </div>

      <div className="set-group-title">Roles</div>
      <div className="set-card">
        {roles.map((role, i) => (
          <div className="set-row" key={i}>
            <div className="set-row-text">
              <input
                type="text"
                className="set-input"
                placeholder="Role name"
                value={role.name}
                onChange={(e) => {
                  const next = [...roles]
                  next[i] = { ...role, name: e.target.value }
                  setDraft(next)
                }}
                onBlur={() => commit(roles)}
              />
              <FieldHint show={duplicateAt(i)}>
                There is already a role named "{role.name.trim()}" — role names must be unique.
              </FieldHint>
              <input
                type="text"
                className="set-input"
                placeholder="Description (shown to the classifier)"
                value={role.description}
                onChange={(e) => {
                  const next = [...roles]
                  next[i] = { ...role, description: e.target.value }
                  setDraft(next)
                }}
                onBlur={() => commit(roles)}
              />
            </div>
            <Select
              ariaLabel={`Model for ${role.name || 'new role'}`}
              value={role.modelRef}
              options={options}
              onChange={(modelRef) => {
                const next = [...roles]
                next[i] = { ...role, modelRef }
                commit(next)
              }}
            />
            <button className="pill-btn" onClick={() => commit(roles.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
        ))}
        <button
          className="pill-btn"
          onClick={() => setDraft([...roles, { name: '', modelRef: '', description: '' }])}
        >
          Add role
        </button>
      </div>
    </>
  )
}
