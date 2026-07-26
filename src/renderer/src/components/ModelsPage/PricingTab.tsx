import { useState } from 'react'
import { useAppStore } from '../../state/store'
import { buildModelRows } from '../../lib/modelRows'
import { relativeAge } from '../../lib/time'
import { ErrorCard } from '../ui/ErrorCard'
import './PricingTab.css'

export function PricingTab(): React.JSX.Element | null {
  const manageableModels = useAppStore((s) => s.manageableModels)
  const providers = useAppStore((s) => s.providers)
  const settings = useAppStore((s) => s.settings)
  const syncPricing = useAppStore((s) => s.syncPricing)

  const [sync, setSync] = useState<{ status: 'idle' | 'pending' | 'done' | 'error'; msg: string }>({
    status: 'idle',
    msg: ''
  })

  if (!settings) return null

  const rows = buildModelRows(manageableModels, providers, settings)

  const runSync = (): void => {
    setSync({ status: 'pending', msg: '' })
    void syncPricing()
      .then((r) => setSync({ status: 'done', msg: `${r.syncedCount} synced · ${r.unmatched.length} unmatched` }))
      .catch((e) => setSync({ status: 'error', msg: e instanceof Error ? e.message : 'Sync failed' }))
  }

  return (
    <div className="pricing-tab">
      <div className="pricing-intro">USD per 1M tokens. Sync pulls current prices from LiteLLM.</div>
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
          {rows.map((row) => (
            <tr key={row.ref}>
              <td className="pricing-model">{row.label}</td>
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
      <div className="pricing-actions">
        <button className="pill-btn" onClick={runSync} disabled={sync.status === 'pending'}>
          {sync.status === 'pending' ? 'Syncing…' : 'Sync prices'}
        </button>
        {sync.status === 'done' ? <span className="pricing-result">{sync.msg}</span> : null}
      </div>
      {sync.status === 'error' ? (
        <div className="pricing-error">
          <ErrorCard>{sync.msg}</ErrorCard>
        </div>
      ) : null}
      <div className="pricing-synced">
        {settings.modelPricingSyncedAt ? `Last synced ${relativeAge(settings.modelPricingSyncedAt)}` : 'Using bundled defaults'}
      </div>
    </div>
  )
}
