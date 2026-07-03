import { useEffect, useRef, useState } from 'react'
import { PROVIDERS } from '../../demo/data'
import { useAppStore } from '../../state/store'
import { IconChevronDown, IconSearch } from '../icons'
import './ModelPicker.css'

export function ModelPicker(): React.JSX.Element {
  const model = useAppStore((s) => s.model)
  const selectModel = useAppStore((s) => s.selectModel)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

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
        <span className="provider-dot" style={{ background: model.color }} />
        <span>{model.name}</span>
        <span className="chev">
          <IconChevronDown />
        </span>
      </button>
      {open ? (
        <div className="menu model-menu">
          {PROVIDERS.map((provider) => {
            const models =
              provider.id === 'openrouter' && search
                ? provider.models.filter((m) => m.toLowerCase().includes(search.toLowerCase()))
                : provider.models
            return (
              <div key={provider.id}>
                <div className="menu-group-label">
                  <span className="provider-dot" style={{ background: provider.color }} />
                  {provider.name}
                </div>
                {provider.id === 'openrouter' ? (
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
                {models.map((name) => (
                  <div
                    key={name}
                    className={'menu-item' + (name === model.name ? ' selected' : '')}
                    onClick={() => {
                      selectModel(name, provider.color)
                      setOpen(false)
                    }}
                  >
                    <span>{name}</span>
                    {provider.local ? <span className="badge local">local</span> : null}
                    <span className="check">✓</span>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
