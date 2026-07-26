import { useAppStore } from '../../state/store'
import { buildModelRows } from '../../lib/modelRows'
import { EmptyState } from '../ui/EmptyState'
import { ProviderIcon } from '../ProviderIcon'
import './CatalogTab.css'

// Discovery view: every currently-DISABLED model, one card each, so enabling a
// model is a browse-and-click action rather than hunting it down in the
// Models tab's table. Populated from the same buildModelRows join as every
// other Models-page surface, filtered to enabled === false.
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

  return (
    <div className="catalog-tab">
      {disabled.map((row) => (
        <div className="ct-card" key={row.ref}>
          <div className="ct-card-head">
            <ProviderIcon provider={row.providerId} size={18} />
            <div className="ct-card-name">{row.label}</div>
          </div>
          <div className="ct-card-vendor">{row.providerDisplayName}</div>
          {row.catalog?.description ? <div className="ct-card-desc">{row.catalog.description}</div> : null}
          <button type="button" className="ct-enable" onClick={() => void setModelEnabled(row.ref, true)}>
            Enable
          </button>
        </div>
      ))}
    </div>
  )
}
