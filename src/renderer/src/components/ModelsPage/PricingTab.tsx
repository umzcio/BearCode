import { useState } from 'react'
import type { ProviderId } from '@shared/types'
import { useAppStore } from '../../state/store'
import { buildModelRows, type ModelRow } from '../../lib/modelRows'
import { EmptyState } from '../ui/EmptyState'
import { ProviderIcon } from '../ProviderIcon'
import { Select, type SelectOption } from '../Select'
import { Toggle } from '../Toggle'
import { IconSearch } from '../icons'
import './PricingTab.css'

const SORT_OPTIONS: SelectOption<'name' | 'price-desc' | 'price-asc'>[] = [
  { value: 'name', label: 'Name (A–Z)' },
  { value: 'price-desc', label: 'Price: high to low' },
  { value: 'price-asc', label: 'Price: low to high' }
]

// Unpriced models (no LiteLLM/default match) sort to the end regardless of
// direction -- "unknown" is neither the most nor least expensive.
function byPrice(a: ModelRow, b: ModelRow, dir: 1 | -1): number {
  if (!a.price && !b.price) return a.label.localeCompare(b.label)
  if (!a.price) return 1
  if (!b.price) return -1
  return dir * (a.price.inputPer1M - b.price.inputPer1M)
}

// Read-only pricing browser: no sync button here -- the Models page header's
// "Sync metadata" action already syncs pricing for the whole page, and a
// second copy of that control/state on this tab was pure duplication.
export function PricingTab(): React.JSX.Element | null {
  const manageableModels = useAppStore((s) => s.manageableModels)
  const providers = useAppStore((s) => s.providers)
  const settings = useAppStore((s) => s.settings)

  const [search, setSearch] = useState('')
  const [vendorFilter, setVendorFilter] = useState<'all' | ProviderId>('all')
  const [enabledOnly, setEnabledOnly] = useState(true)
  const [sort, setSort] = useState<'name' | 'price-desc' | 'price-asc'>('name')

  if (!settings) return null

  const allRows = buildModelRows(manageableModels, providers, settings)

  const vendorOptions: SelectOption<'all' | ProviderId>[] = [
    { value: 'all', label: 'All vendors' },
    ...manageableModels.map((p) => ({ value: p.id, label: p.displayName }))
  ]

  const filtered = allRows.filter((row) => {
    const q = search.trim().toLowerCase()
    if (q && !row.label.toLowerCase().includes(q) && !row.providerDisplayName.toLowerCase().includes(q))
      return false
    if (vendorFilter !== 'all' && row.providerId !== vendorFilter) return false
    if (enabledOnly && !row.enabled) return false
    return true
  })

  const sorted = [...filtered].sort((a, b) => {
    if (sort === 'name') return a.label.localeCompare(b.label)
    return byPrice(a, b, sort === 'price-desc' ? -1 : 1)
  })

  return (
    <div className="pricing-tab">
      <div className="pt-intro">USD per 1M tokens.</div>
      <div className="pt-toolbar">
        <div className="pt-search">
          <IconSearch size={14} />
          <input
            placeholder="Search models…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select
          ariaLabel="Filter by vendor"
          value={vendorFilter}
          onChange={setVendorFilter}
          options={vendorOptions}
          compact
        />
        <Select ariaLabel="Sort" value={sort} onChange={setSort} options={SORT_OPTIONS} compact />
        <label className="pt-enabled-only">
          <Toggle checked={enabledOnly} ariaLabel="Show enabled only" onChange={setEnabledOnly} />
          Show enabled only
        </label>
      </div>

      {sorted.length === 0 ? (
        <EmptyState title="No models match these filters" />
      ) : (
        <table className="pricing-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Input</th>
              <th>Output</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr key={row.ref}>
                <td className="pricing-model">
                  <div className="pt-model">
                    <ProviderIcon provider={row.providerId} size={16} />
                    <div>
                      <div className="pt-model-name">{row.label}</div>
                      <div className="pt-model-vendor">{row.providerDisplayName}</div>
                    </div>
                  </div>
                </td>
                <td>{row.price ? `$${row.price.inputPer1M}` : '—'}</td>
                <td>{row.price ? `$${row.price.outputPer1M}` : '—'}</td>
                <td>
                  {row.priceSource ? (
                    <span className={'price-src ' + row.priceSource}>{row.priceSource}</span>
                  ) : (
                    <span className="price-src none">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
