import { useState } from 'react'
import type { JSX } from 'react'
import type { AppSettings, UrsaRole } from '@shared/types'
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
    // A row must be BOTH named and have a model picked before it's eligible
    // to persist -- a named-but-modelRef-less row (the natural fill order:
    // type the name, blur, then open the model dropdown) would otherwise be
    // dropped by settings.ts's coerceUrsaRoles (which requires a valid
    // "provider/modelId" modelRef) on the very next save, silently vanishing
    // from the UI once the coerced response replaces the store. Gating the
    // save on completeness keeps the incomplete row alive in local draft
    // state (set above) until the user finishes it.
    const namedRoles = next.filter((r) => r.name.trim().length > 0)
    const allComplete = namedRoles.every((r) => r.modelRef.trim().length > 0)
    const names = namedRoles.map((r) => r.name.trim())
    const hasDupe = new Set(names).size !== names.length
    if (allComplete && !hasDupe) {
      void saveSettings({ ursaRoles: namedRoles }).then(() => setDraft(null))
    }
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

      <div className="set-group-title">Guardrails</div>
      <div className="set-card">
        {roles.filter((r) => r.name.trim().length > 0).length === 0 ? (
          <div className="set-row-desc">Add a named role above to set a spend ceiling for it.</div>
        ) : (
          roles
            .filter((r) => r.name.trim().length > 0)
            .map((role) => (
              <CeilingRow
                key={role.name}
                roleName={role.name}
                guardrails={settings.ursaGuardrails}
                saveSettings={saveSettings}
              />
            ))
        )}
      </div>
    </>
  )
}

// A single role's per-project spend ceiling. Local draft-string state so the
// user can freely type/clear the field; commits a parsed number (or removes
// the ceiling entirely on an empty/invalid value) on blur, matching the
// draft-then-save-on-blur pattern the rest of this page and GeneralPage use.
function CeilingRow({
  roleName,
  guardrails,
  saveSettings
}: {
  roleName: string
  guardrails: { roleCeilings: Record<string, number> }
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>
}): JSX.Element {
  const saved = guardrails.roleCeilings[roleName]
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? (saved != null ? String(saved) : '')

  const commit = (): void => {
    const trimmed = (draft ?? '').trim()
    const parsed = trimmed === '' ? null : Number(trimmed)
    const next = { ...guardrails.roleCeilings }
    if (parsed == null || !Number.isFinite(parsed) || parsed < 0) {
      delete next[roleName]
    } else {
      next[roleName] = parsed
    }
    setDraft(null)
    void saveSettings({ ursaGuardrails: { roleCeilings: next } })
  }

  return (
    <div className="set-row">
      <div className="set-row-text">
        <div className="set-row-title">{roleName}</div>
        <div className="set-row-desc">
          Project spend ceiling (USD). Leave blank for no ceiling.
        </div>
      </div>
      <input
        type="text"
        inputMode="decimal"
        className="set-input"
        placeholder="No ceiling"
        value={value}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
      />
    </div>
  )
}
