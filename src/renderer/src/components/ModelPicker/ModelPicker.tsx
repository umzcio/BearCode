import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ProviderId } from '@shared/types'
import { URSA_MODEL_REF } from '@shared/types'
import { modelDisplay, useAppStore } from '../../state/store'
import { ProviderIcon } from '../ProviderIcon'
import { Hint } from '../Hint'
import { IconChevronDown, IconSearch } from '../icons'
import { Popover } from '../ui/Popover'
import './ModelPicker.css'

export function ModelPicker(): React.JSX.Element {
  const providers = useAppStore((s) => s.providers)
  const modelRef = useAppStore((s) => s.modelRef)
  const selectModel = useAppStore((s) => s.selectModel)
  const openSettings = useAppStore((s) => s.openSettings)
  const modelMenuTick = useAppStore((s) => s.modelMenuTick)
  const settings = useAppStore((s) => s.settings)
  const hasUrsaRoles = (settings?.ursaRoles?.length ?? 0) > 0
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const lastTick = useRef(modelMenuTick)

  const current = modelDisplay(providers, modelRef)

  // Flatten the grouped/filtered menu into the navigable options, in the same
  // order they render, so keyboard nav and the mouse click handlers commit
  // the identical action.
  const flatOptions: { id: string; commit: () => void }[] = []
  if (hasUrsaRoles) {
    flatOptions.push({
      id: 'model-ursa',
      commit: () => {
        selectModel(URSA_MODEL_REF)
        setOpen(false)
      }
    })
  }
  providers.forEach((provider) => {
    const dimmed = provider.requiresKey && !provider.keyConfigured
    const models =
      provider.id === 'openrouter' && search
        ? provider.models.filter((m) => m.label.toLowerCase().includes(search.toLowerCase()))
        : provider.models
    if (!provider.reachable) return
    if (dimmed) {
      flatOptions.push({
        id: `addkey-${provider.id}`,
        commit: () => {
          setOpen(false)
          openSettings('providers')
        }
      })
      return
    }
    models.forEach((model) => {
      const ref = `${provider.id}/${model.id}`
      flatOptions.push({
        id: `model-${ref}`,
        commit: () => {
          selectModel(ref)
          setOpen(false)
        }
      })
    })
  })

  // Cmd+/ toggles the menu. Compare against the last seen tick so this only
  // fires on a real tick change, not on mount or StrictMode's double-run.
  useEffect(() => {
    if (lastTick.current === modelMenuTick) return
    lastTick.current = modelMenuTick
    setOpen((o) => !o)
  }, [modelMenuTick])

  // Popover owns click-outside/Esc/scroll dismissal + positioning. This
  // effect only seeds the roving highlight on the current model and focuses
  // the listbox so it receives arrow keys -- stays a useLayoutEffect (not
  // useEffect) because Popover measures + positions itself in its own
  // useLayoutEffect on the same open transition, and layout effects fire
  // bottom-up (Popover, nested inside this component, before this one), so
  // the listbox is never `visibility: hidden` when `.focus()` is called
  // (Chromium silently no-ops focus on a hidden element). See Popover.tsx.
  useLayoutEffect(() => {
    if (!open) return
    const i = flatOptions.findIndex((o) => o.id === `model-${modelRef}`)
    setActiveIndex(i >= 0 ? i : 0)
    menuRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const onMenuKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(flatOptions.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(0, i - 1))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActiveIndex(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActiveIndex(flatOptions.length - 1)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      flatOptions[activeIndex]?.commit()
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div className="model-picker">
      <Hint label="Select Model" keys="⌘/" side="top" disabled={open}>
        <button ref={triggerRef} className="pill-btn" onClick={() => setOpen((o) => !o)}>
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
      <Popover
        anchorRef={triggerRef}
        open={open}
        onClose={() => setOpen(false)}
        placement="top-end"
      >
        <div
          className="menu menu--in-popover model-menu"
          role="listbox"
          ref={menuRef}
          tabIndex={-1}
          aria-activedescendant={`opt-${flatOptions[activeIndex]?.id}`}
          onKeyDown={onMenuKey}
        >
          <div
            id="opt-model-ursa"
            role="option"
            aria-selected={modelRef === URSA_MODEL_REF}
            aria-disabled={!hasUrsaRoles}
            className={
              'menu-item ursa-entry' +
              (modelRef === URSA_MODEL_REF ? ' selected' : '') +
              (!hasUrsaRoles ? ' disabled' : '') +
              (flatOptions[activeIndex]?.id === 'model-ursa' ? ' active' : '')
            }
            onClick={() => {
              if (!hasUrsaRoles) return
              const idx = flatOptions.findIndex((o) => o.id === 'model-ursa')
              flatOptions[idx]?.commit()
            }}
            onMouseEnter={() => {
              if (hasUrsaRoles) {
                const idx = flatOptions.findIndex((o) => o.id === 'model-ursa')
                setActiveIndex(idx)
              }
            }}
          >
            <span>Ursa</span>
            {!hasUrsaRoles ? (
              <span className="ursa-hint">Add a role in Settings &gt; Ursa first</span>
            ) : null}
            <span className="check">✓</span>
          </div>
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
                  (() => {
                    const idx = flatOptions.findIndex((o) => o.id === `addkey-${provider.id}`)
                    return (
                      <div
                        id={`opt-addkey-${provider.id}`}
                        role="option"
                        aria-selected={false}
                        className={'menu-item add-key' + (idx === activeIndex ? ' active' : '')}
                        onClick={() => flatOptions[idx]?.commit()}
                        onMouseEnter={() => setActiveIndex(idx)}
                      >
                        <span>Add API key</span>
                      </div>
                    )
                  })()
                ) : (
                  models.map((model) => {
                    const ref = `${provider.id}/${model.id}`
                    const idx = flatOptions.findIndex((o) => o.id === `model-${ref}`)
                    return (
                      <div
                        key={model.id}
                        id={`opt-model-${ref}`}
                        role="option"
                        aria-selected={ref === modelRef}
                        className={
                          'menu-item' +
                          (ref === modelRef ? ' selected' : '') +
                          (idx === activeIndex ? ' active' : '')
                        }
                        onClick={() => flatOptions[idx]?.commit()}
                        onMouseEnter={() => setActiveIndex(idx)}
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
      </Popover>
    </div>
  )
}
