import { useState } from 'react'
import type { ProviderId } from '@shared/types'
import { useAppStore } from '../../state/store'
import { buildModelRows, CAPABILITY_LABEL, type CapabilityKey, type ModelRow } from '../../lib/modelRows'
import { EmptyState } from '../ui/EmptyState'
import { ProviderIcon } from '../ProviderIcon'
import { Select, type SelectOption } from '../Select'
import { IconSearch } from '../icons'
import './CatalogTab.css'

const CAPABILITY_OPTIONS: SelectOption<'all' | CapabilityKey>[] = [
  { value: 'all', label: 'All capabilities' },
  ...(Object.entries(CAPABILITY_LABEL) as [CapabilityKey, string][]).map(([value, label]) => ({
    value,
    label
  }))
]

const SORT_OPTIONS: SelectOption<'vendor' | 'name'>[] = [
  { value: 'vendor', label: 'Group by vendor' },
  { value: 'name', label: 'Name (A–Z)' }
]

function Row({ row, onEnable }: { row: ModelRow; onEnable: (ref: string) => void }): React.JSX.Element {
  return (
    <div className="ct-row" key={row.ref}>
      <ProviderIcon provider={row.providerId} size={16} />
      <div className="ct-row-text">
        <span className="ct-row-name">{row.label}</span>
        {row.catalog?.description ? <span className="ct-row-desc">{row.catalog.description}</span> : null}
      </div>
      <button type="button" className="ct-enable" onClick={() => onEnable(row.ref)}>
        Enable
      </button>
    </div>
  )
}

// Discovery view: every currently-DISABLED model, filterable/sortable and
// grouped by vendor as a compact row-list (not cards -- once live-only models
// default to disabled, this list is routinely dozens of models long, and a
// card grid doesn't scale; rows match the density the Models tab's table
// already uses).
export function CatalogTab(): React.JSX.Element {
  const manageableModels = useAppStore((s) => s.manageableModels)
  const providers = useAppStore((s) => s.providers)
  const settings = useAppStore((s) => s.settings)
  const setModelEnabled = useAppStore((s) => s.setModelEnabled)

  const [search, setSearch] = useState('')
  const [vendorFilter, setVendorFilter] = useState<'all' | ProviderId>('all')
  const [capabilityFilter, setCapabilityFilter] =
    useState<(typeof CAPABILITY_OPTIONS)[number]['value']>('all')
  const [sort, setSort] = useState<'vendor' | 'name'>('vendor')

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

  const vendorOptions: SelectOption<'all' | ProviderId>[] = [
    { value: 'all', label: 'All vendors' },
    ...manageableModels.map((p) => ({ value: p.id, label: p.displayName }))
  ]

  const filtered = disabled.filter((row) => {
    const q = search.trim().toLowerCase()
    if (q && !row.label.toLowerCase().includes(q) && !row.providerDisplayName.toLowerCase().includes(q))
      return false
    if (vendorFilter !== 'all' && row.providerId !== vendorFilter) return false
    if (capabilityFilter !== 'all' && !(row.metadata?.capabilities[capabilityFilter] ?? false))
      return false
    return true
  })

  const handleEnable = (ref: string): void => void setModelEnabled(ref, true)

  const toolbar = (
    <div className="ct-toolbar">
      <div className="ct-search">
        <IconSearch size={14} />
        <input
          placeholder="Search catalog…"
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
      <Select
        ariaLabel="Filter by capability"
        value={capabilityFilter}
        onChange={setCapabilityFilter}
        options={CAPABILITY_OPTIONS}
        compact
      />
      <Select ariaLabel="Sort" value={sort} onChange={setSort} options={SORT_OPTIONS} compact />
    </div>
  )

  if (filtered.length === 0) {
    return (
      <div className="catalog-tab">
        {toolbar}
        <EmptyState title="No models match these filters" />
      </div>
    )
  }

  if (sort === 'name') {
    const flat = [...filtered].sort((a, b) => a.label.localeCompare(b.label))
    return (
      <div className="catalog-tab">
        {toolbar}
        <div className="ct-group">
          {flat.map((row) => (
            <Row row={row} onEnable={handleEnable} key={row.ref} />
          ))}
        </div>
      </div>
    )
  }

  const groups = new Map<string, ModelRow[]>()
  for (const row of filtered) {
    const list = groups.get(row.providerDisplayName) ?? []
    list.push(row)
    groups.set(row.providerDisplayName, list)
  }
  const sortedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
  for (const [, rows] of sortedGroups) rows.sort((a, b) => a.label.localeCompare(b.label))

  return (
    <div className="catalog-tab">
      {toolbar}
      {sortedGroups.map(([vendor, rows]) => (
        <div className="ct-group" key={vendor}>
          <div className="ct-group-head">{vendor}</div>
          {rows.map((row) => (
            <Row row={row} onEnable={handleEnable} key={row.ref} />
          ))}
        </div>
      ))}
    </div>
  )
}
