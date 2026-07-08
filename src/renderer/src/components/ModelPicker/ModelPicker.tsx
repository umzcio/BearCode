import { useEffect, useRef, useState } from 'react'
import type { ProviderId } from '@shared/types'
import { modelDisplay, useAppStore } from '../../state/store'
import { ProviderIcon } from '../ProviderIcon'
import { Hint } from '../Hint'
import { IconChevronDown, IconSearch } from '../icons'
import './ModelPicker.css'

export function ModelPicker(): React.JSX.Element {
  const providers = useAppStore((s) => s.providers)
  const modelRef = useAppStore((s) => s.modelRef)
  const selectModel = useAppStore((s) => s.selectModel)
  const openSettings = useAppStore((s) => s.openSettings)
  const modelMenuTick = useAppStore((s) => s.modelMenuTick)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const lastTick = useRef(modelMenuTick)

  const current = modelDisplay(providers, modelRef)

  // Cmd+/ toggles the menu. Compare against the last seen tick so this only
  // fires on a real tick change, not on mount or StrictMode's double-run.
  useEffect(() => {
    if (lastTick.current === modelMenuTick) return
    lastTick.current = modelMenuTick
    setOpen((o) => !o)
  }, [modelMenuTick])

  useEffect(() => {
    if (!open) return undefined
    const close = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="model-picker" ref={rootRef}>
      <Hint label="Select Model" keys="⌘/" side="top" disabled={open}>
        <button className="pill-btn" onClick={() => setOpen((o) => !o)}>
          {modelRef ? (
            <ProviderIcon provider={modelRef.slice(0, modelRef.indexOf('/')) as ProviderId} />
          ) : (
            <span className="provider-dot" style={{ background: current.color }} />
          )}
          <span className="model-name">{current.name}</span>
          <span className="chev">
            <IconChevronDown />
          </span>
        </button>
      </Hint>
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
                      openSettings('providers')
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
