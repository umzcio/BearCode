import { useEffect, useRef, useState } from 'react'
import type { ProviderId } from '@shared/types'
import { modelDisplay, useAppStore } from '../../state/store'
import { ProviderIcon } from '../ProviderIcon'
import { IconChevronDown, IconSearch } from '../icons'
import './ModelPicker.css'

export function ModelPicker(): React.JSX.Element {
  const providers = useAppStore((s) => s.providers)
  const modelRef = useAppStore((s) => s.modelRef)
  const selectModel = useAppStore((s) => s.selectModel)
  const openSettings = useAppStore((s) => s.openSettings)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  const current = modelDisplay(providers, modelRef)

  useEffect(() => {
    if (!open) return undefined
    const close = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [open])

  return (
    <div className="model-picker" ref={rootRef}>
      <button className="pill-btn" onClick={() => setOpen((o) => !o)}>
        {modelRef ? (
          <ProviderIcon provider={modelRef.slice(0, modelRef.indexOf('/')) as ProviderId} />
        ) : (
          <span className="provider-dot" style={{ background: current.color }} />
        )}
        <span>{current.name}</span>
        <span className="chev">
          <IconChevronDown />
        </span>
      </button>
      {open ? (
        <div className="menu model-menu">
          {providers.map((provider) => {
            const dimmed = provider.requiresKey && !provider.keyConfigured
            const models =
              provider.id === 'openrouter' && search
                ? provider.models.filter((m) =>
                    m.label.toLowerCase().includes(search.toLowerCase())
                  )
                : provider.models
            return (
              <div key={provider.id}>
                <div className="menu-group-label">
                  <span className="group-icon">
                    <ProviderIcon provider={provider.id} size={14} />
                  </span>
                  {provider.displayName}
                </div>
                {provider.id === 'openrouter' && !dimmed ? (
                  <div className="menu-search">
                    <IconSearch />
                    <input
                      placeholder="Search models"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>
                ) : null}
                {!provider.reachable ? (
                  <div className="menu-item disabled">
                    <span>{provider.note ?? 'Not reachable'}</span>
                  </div>
                ) : dimmed ? (
                  <div
                    className="menu-item add-key"
                    onClick={() => {
                      setOpen(false)
                      openSettings()
                    }}
                  >
                    <span>Add API key</span>
                  </div>
                ) : (
                  models.map((model) => {
                    const ref = `${provider.id}/${model.id}`
                    return (
                      <div
                        key={model.id}
                        className={'menu-item' + (ref === modelRef ? ' selected' : '')}
                        onClick={() => {
                          selectModel(ref)
                          setOpen(false)
                        }}
                      >
                        <span>{model.label}</span>
                        {provider.id === 'ollama' ? (
                          <span className="badge local">local</span>
                        ) : null}
                        <span className="check">✓</span>
                      </div>
                    )
                  })
                )}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
