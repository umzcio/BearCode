import { useEffect, useState } from 'react'
import { useAppStore } from '../../state/store'
import { relativeAge } from '../../lib/time'
import { ModelsTab } from './ModelsTab'
import { CatalogTab } from './CatalogTab'
import { PricingTab } from './PricingTab'
import { ErrorCard } from '../ui/ErrorCard'
import './ModelsPage.css'

type Tab = 'models' | 'catalog' | 'pricing'
const TABS: { id: Tab; label: string }[] = [
  { id: 'models', label: 'Models' },
  { id: 'catalog', label: 'Catalog' },
  { id: 'pricing', label: 'Pricing' }
]

export function ModelsPage(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const syncPricing = useAppStore((s) => s.syncPricing)
  const refreshManageableModels = useAppStore((s) => s.refreshManageableModels)
  const [tab, setTab] = useState<Tab>('models')
  const [sync, setSync] = useState<{ status: 'idle' | 'pending' | 'error'; msg: string }>({
    status: 'idle',
    msg: ''
  })

  // The store's `manageableModels` initializes to `[]` and is otherwise only
  // ever refreshed internally by setModelEnabled/addCustomModel/removeCustomModel
  // after a mutation -- nothing else triggers the FIRST load. Without this the
  // page renders empty on every fresh launch.
  useEffect(() => {
    void refreshManageableModels()
  }, [refreshManageableModels])

  const runSync = (): void => {
    setSync({ status: 'pending', msg: '' })
    void syncPricing()
      .then(() => setSync({ status: 'idle', msg: '' }))
      .catch((e) => setSync({ status: 'error', msg: e instanceof Error ? e.message : 'Sync failed' }))
  }

  return (
    <div className="models-page">
      <div className="mp-head">
        <div className="mp-headtext">
          <div className="page-title">Models</div>
          <div className="page-sub">
            Every model available to BearCode -- capabilities, pricing, and status in one place.
          </div>
        </div>
        <button
          type="button"
          className="pill-btn"
          onClick={runSync}
          disabled={sync.status === 'pending'}
        >
          {sync.status === 'pending' ? 'Syncing…' : 'Sync metadata'}
        </button>
        <span className="mp-synced">
          {settings?.modelPricingSyncedAt
            ? `Last synced ${relativeAge(settings.modelPricingSyncedAt)}`
            : 'Never synced'}
        </span>
      </div>

      {sync.status === 'error' ? <ErrorCard>{sync.msg}</ErrorCard> : null}

      <div className="mp-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={'mp-tab' + (tab === t.id ? ' active' : '')}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mp-body">
        {tab === 'models' ? <ModelsTab /> : null}
        {tab === 'catalog' ? <CatalogTab /> : null}
        {tab === 'pricing' ? <PricingTab /> : null}
      </div>
    </div>
  )
}
