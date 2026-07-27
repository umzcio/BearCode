import { useAppStore } from '../../state/store'
import { buildModelRows, type ModelRow } from '../../lib/modelRows'
import { EmptyState } from '../ui/EmptyState'
import { ProviderIcon } from '../ProviderIcon'
import './CatalogTab.css'

// Discovery view: every currently-DISABLED model, grouped by vendor as a
// compact row-list (not cards -- once live-only models default to disabled,
// this list is routinely dozens of models long, and a card grid doesn't
// scale; rows match the density the Models tab's table already uses).
export function CatalogTab(): React.JSX.Element {
  const manageableModels = useAppStore((s) => s.manageableModels)
  const providers = useAppStore((s) => s.providers)
  const settings = useAppStore((s) => s.settings)
  const setModelEnabled = useAppStore((s) => s.setModelEnabled)

  if (!settings) return <EmptyState title="Loading models…" />

  const disabled = buildModelRows(manageableModels, providers, settings).filter((r) => !r.enabled)

  if (disabled.length === 0) {
    return (
      <EmptyState
        title="All models are enabled"
        hint="Disabled models you enable will disappear from this list."
      />
    )
  }

  const groups = new Map<string, ModelRow[]>()
  for (const row of disabled) {
    const list = groups.get(row.providerDisplayName) ?? []
    list.push(row)
    groups.set(row.providerDisplayName, list)
  }

  return (
    <div className="catalog-tab">
      {[...groups.entries()].map(([vendor, rows]) => (
        <div className="ct-group" key={vendor}>
          <div className="ct-group-head">{vendor}</div>
          {rows.map((row) => (
            <div className="ct-row" key={row.ref}>
              <ProviderIcon provider={row.providerId} size={16} />
              <div className="ct-row-text">
                <span className="ct-row-name">{row.label}</span>
                {row.catalog?.description ? (
                  <span className="ct-row-desc">{row.catalog.description}</span>
                ) : null}
              </div>
              <button
                type="button"
                className="ct-enable"
                onClick={() => void setModelEnabled(row.ref, true)}
              >
                Enable
              </button>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
