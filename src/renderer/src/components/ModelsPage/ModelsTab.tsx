import { useMemo, useState } from 'react'
import type { ProviderId } from '@shared/types'
import { useAppStore } from '../../state/store'
import { buildModelRows, formatTokens, type ModelStatus } from '../../lib/modelRows'
import { Select, type SelectOption } from '../Select'
import { Toggle } from '../Toggle'
import { EmptyState } from '../ui/EmptyState'
import { ProviderIcon } from '../ProviderIcon'
import { IconDots, IconSearch, IconStar } from '../icons'
import { ModelDetailModal } from './ModelDetailModal'
import './ModelsTab.css'

const STATUS_LABEL: Record<ModelStatus, string> = {
  available: 'Available',
  'not-configured': 'Provider not configured',
  unavailable: 'Unavailable'
}

const CAPABILITY_OPTIONS: SelectOption<
  'all' | 'functionCalling' | 'vision' | 'responseSchema' | 'reasoning' | 'webSearch'
>[] = [
  { value: 'all', label: 'All capabilities' },
  { value: 'functionCalling', label: 'Function calling' },
  { value: 'vision', label: 'Vision' },
  { value: 'responseSchema', label: 'Structured output' },
  { value: 'reasoning', label: 'Reasoning' },
  { value: 'webSearch', label: 'Web search' }
]

const STATUS_OPTIONS: SelectOption<'all' | ModelStatus>[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'available', label: 'Available' },
  { value: 'not-configured', label: 'Not configured' },
  { value: 'unavailable', label: 'Unavailable' }
]

const PAGE_SIZE_OPTIONS: SelectOption<'10' | '25' | '50'>[] = [
  { value: '10', label: '10' },
  { value: '25', label: '25' },
  { value: '50', label: '50' }
]

export function ModelsTab(): React.JSX.Element {
  const manageableModels = useAppStore((s) => s.manageableModels)
  const providers = useAppStore((s) => s.providers)
  const settings = useAppStore((s) => s.settings)
  const setModelEnabled = useAppStore((s) => s.setModelEnabled)
  const saveSettings = useAppStore((s) => s.saveSettings)
  const openSettings = useAppStore((s) => s.openSettings)

  const [search, setSearch] = useState('')
  const [vendorFilter, setVendorFilter] = useState<'all' | ProviderId>('all')
  const [capabilityFilter, setCapabilityFilter] = useState<(typeof CAPABILITY_OPTIONS)[number]['value']>(
    'all'
  )
  const [statusFilter, setStatusFilter] = useState<'all' | ModelStatus>('all')
  const [enabledOnly, setEnabledOnly] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<'10' | '25' | '50'>('25')
  const [openRef, setOpenRef] = useState<string | null>(null)

  const vendorOptions: SelectOption<'all' | ProviderId>[] = [
    { value: 'all', label: 'All vendors' },
    ...manageableModels.map((p) => ({ value: p.id, label: p.displayName }))
  ]

  // The default-model box: the EFFECTIVE (enabled) model set across
  // providers, same source `Settings/pages/ModelsPage.tsx` used to use --
  // never the manageable (including-disabled) set.
  const defaultModelOptions: SelectOption<string>[] = [
    { value: '', label: 'Last used' },
    ...providers.flatMap((p) =>
      p.models.map((m) => ({ value: `${p.id}/${m.id}`, label: `${p.displayName}: ${m.label}` }))
    )
  ]

  const allRows = useMemo(
    () => (settings ? buildModelRows(manageableModels, providers, settings) : []),
    [manageableModels, providers, settings]
  )

  const filtered = allRows.filter((row) => {
    if (search.trim() && !row.label.toLowerCase().includes(search.trim().toLowerCase())) return false
    if (vendorFilter !== 'all' && row.providerId !== vendorFilter) return false
    if (capabilityFilter !== 'all' && !(row.metadata?.capabilities[capabilityFilter] ?? false))
      return false
    if (statusFilter !== 'all' && row.status !== statusFilter) return false
    if (enabledOnly && !row.enabled) return false
    return true
  })

  const size = Number(pageSize)
  const pageCount = Math.max(1, Math.ceil(filtered.length / size))
  const clampedPage = Math.min(page, pageCount)
  const start = (clampedPage - 1) * size
  const pageRows = filtered.slice(start, start + size)

  const toggleFavorite = (ref: string): void => {
    if (!settings) return
    const set = new Set(settings.favoriteModels ?? [])
    if (set.has(ref)) set.delete(ref)
    else set.add(ref)
    void saveSettings({ favoriteModels: [...set] })
  }

  if (!settings) return <EmptyState title="Loading models…" />

  return (
    <div className="models-tab">
      <div className="mt-toolbar">
        <Select
          ariaLabel="Default model"
          value={settings.defaultModelRef ?? ''}
          onChange={(v) => void saveSettings({ defaultModelRef: v || null })}
          options={defaultModelOptions}
          compact
        />
        <div className="mt-search">
          <IconSearch size={14} />
          <input
            placeholder="Search models…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(1)
            }}
          />
        </div>
        <Select
          ariaLabel="Filter by vendor"
          value={vendorFilter}
          onChange={(v) => {
            setVendorFilter(v)
            setPage(1)
          }}
          options={vendorOptions}
          compact
        />
        <Select
          ariaLabel="Filter by capability"
          value={capabilityFilter}
          onChange={(v) => {
            setCapabilityFilter(v)
            setPage(1)
          }}
          options={CAPABILITY_OPTIONS}
          compact
        />
        <Select
          ariaLabel="Filter by status"
          value={statusFilter}
          onChange={(v) => {
            setStatusFilter(v)
            setPage(1)
          }}
          options={STATUS_OPTIONS}
          compact
        />
        <label className="mt-enabled-only">
          <Toggle
            checked={enabledOnly}
            ariaLabel="Show enabled only"
            onChange={(on) => {
              setEnabledOnly(on)
              setPage(1)
            }}
          />
          Show enabled only
        </label>
      </div>

      {pageRows.length === 0 ? (
        <EmptyState title="No models match these filters" />
      ) : (
        <table className="mt-table">
          <thead>
            <tr>
              <th aria-hidden="true" />
              <th>Model</th>
              <th>Context</th>
              <th>Capabilities</th>
              <th>Pricing</th>
              <th>Status</th>
              <th>Enabled</th>
              <th aria-hidden="true" />
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row) => {
              const caps = row.metadata
                ? (Object.entries(row.metadata.capabilities) as [string, boolean][])
                    .filter(([, on]) => on)
                    .map(([k]) => k)
                : null
              return (
                <tr className="mt-row" key={row.ref}>
                  <td>
                    <button
                      type="button"
                      className={'mt-fav' + (row.favorite ? ' active' : '')}
                      aria-label={row.favorite ? `Unfavorite ${row.label}` : `Favorite ${row.label}`}
                      onClick={() => toggleFavorite(row.ref)}
                    >
                      <IconStar size={14} />
                    </button>
                  </td>
                  <td>
                    <div className="mt-model">
                      <ProviderIcon provider={row.providerId} size={16} />
                      <div>
                        <div className="mt-model-name">{row.label}</div>
                        <div className="mt-model-vendor">{row.providerDisplayName}</div>
                      </div>
                    </div>
                  </td>
                  <td>{formatTokens(row.contextWindow)}</td>
                  <td>
                    {caps === null ? (
                      <span className="mt-caps-unknown">Unknown</span>
                    ) : caps.length === 0 ? (
                      <span className="mt-caps-unknown">—</span>
                    ) : (
                      <div className="mt-caps">
                        {caps.slice(0, 3).map((c) => (
                          <span className="chip" key={c}>
                            {c}
                          </span>
                        ))}
                        {caps.length > 3 ? <span className="chip">+{caps.length - 3}</span> : null}
                      </div>
                    )}
                  </td>
                  <td>
                    {row.price ? (
                      <div className="mt-price">
                        <div>${row.price.inputPer1M} in</div>
                        <div>${row.price.outputPer1M} out</div>
                      </div>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    <span className="mt-status">
                      <span
                        className={
                          'status-dot' +
                          (row.status === 'available'
                            ? ' ok'
                            : row.status === 'not-configured'
                              ? ' warn'
                              : ' err')
                        }
                      />
                      {STATUS_LABEL[row.status]}
                      {row.status !== 'available' ? (
                        <button
                          type="button"
                          className="mt-status-link"
                          onClick={() => openSettings('providers')}
                        >
                          {row.status === 'not-configured' ? 'Configure →' : 'Check status →'}
                        </button>
                      ) : null}
                    </span>
                  </td>
                  <td>
                    <Toggle
                      checked={row.enabled}
                      ariaLabel={`${row.label} enabled`}
                      onChange={(on) => void setModelEnabled(row.ref, on)}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="mt-more"
                      aria-label="More actions"
                      onClick={() => setOpenRef(row.ref)}
                    >
                      <IconDots size={14} />
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      <div className="mt-pagination">
        <span>
          {filtered.length === 0
            ? 'Showing 0 of 0'
            : `Showing ${start + 1}–${Math.min(start + size, filtered.length)} of ${filtered.length}`}
        </span>
        <Select
          ariaLabel="Page size"
          value={pageSize}
          onChange={(v) => {
            setPageSize(v)
            setPage(1)
          }}
          options={PAGE_SIZE_OPTIONS}
          compact
        />
        <button
          type="button"
          aria-label="Previous page"
          disabled={clampedPage <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
        >
          Prev
        </button>
        <span className="mt-page-of">
          Page {clampedPage} of {pageCount}
        </span>
        <button
          type="button"
          aria-label="Next page"
          disabled={clampedPage >= pageCount}
          onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
        >
          Next
        </button>
      </div>

      <ModelDetailModal modelRef={openRef} onClose={() => setOpenRef(null)} />
    </div>
  )
}
