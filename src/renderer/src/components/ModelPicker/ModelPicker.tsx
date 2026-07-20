import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ProviderId } from '@shared/types'
import { URSA_MODEL_REF, URSUS_MODEL_REF } from '@shared/types'
import { modelDisplay, useAppStore } from '../../state/store'
import { ProviderIcon } from '../ProviderIcon'
import { Hint } from '../Hint'
import { IconChevronDown, IconSearch } from '../icons'
import { Popover } from '../ui/Popover'
import ursaTeddy from '../../assets/ursa-teddy.svg'
import ursusBear from '../../assets/ursus-bear.svg'
import { useCloseOnSettingsOpen } from '../../lib/useCloseOnSettingsOpen'
import './ModelPicker.css'

export function ModelPicker(): React.JSX.Element {
  const providers = useAppStore((s) => s.providers)
  const modelRef = useAppStore((s) => s.modelRef)
  const selectModel = useAppStore((s) => s.selectModel)
  const openSettings = useAppStore((s) => s.openSettings)
  const modelMenuTick = useAppStore((s) => s.modelMenuTick)
  const settings = useAppStore((s) => s.settings)
  // Ursa's roles are curated in code (main/orchestrator/ursa.ts), not user
  // data -- the renderer only needs to know whether Ursa is turned on and
  // whether at least one provider is usable at all, not which specific
  // curated roles exist (that would duplicate CURATED_ROLES across the
  // Electron process boundary for no benefit).
  const ursaEnabled = settings?.ursaEnabled === true
  const anyProviderUsable = providers.some((p) => p.reachable && (!p.requiresKey || p.keyConfigured))
  const ursaSelectable = ursaEnabled && anyProviderUsable
  // Ursus is restricted to openrouter/ollama -- unlike Ursa's "any provider at
  // all" check, this must specifically check those two, not the whole list.
  // Both reads come from the already-polled providers store state (never a
  // fresh async probe inline in render -- see planning/2026-07-20-ursus-design.md
  // "Where the async check runs").
  const ursusEnabled = settings?.ursusEnabled === true
  const openrouterUsable = providers.some(
    (p) => p.id === 'openrouter' && p.reachable && p.keyConfigured
  )
  const ollamaUsable = providers.some((p) => p.id === 'ollama' && p.reachable)
  const ursusSelectable = ursusEnabled && (openrouterUsable || ollamaUsable)
  const [open, setOpen] = useState(false)
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  useCloseOnSettingsOpen(open, settingsOpen, () => setOpen(false))
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
  if (ursaSelectable) {
    flatOptions.push({
      id: 'model-ursa',
      commit: () => {
        selectModel(URSA_MODEL_REF)
        setOpen(false)
      }
    })
  }
  if (ursusSelectable) {
    flatOptions.push({
      id: 'model-ursus',
      commit: () => {
        selectModel(URSUS_MODEL_REF)
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
    const targetId =
      modelRef === URSA_MODEL_REF
        ? 'model-ursa'
        : modelRef === URSUS_MODEL_REF
          ? 'model-ursus'
          : `model-${modelRef}`
    const i = flatOptions.findIndex((o) => o.id === targetId)
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
          {modelRef === URSA_MODEL_REF ? (
            <img src={ursaTeddy} alt="" className="ursa-icon" />
          ) : modelRef === URSUS_MODEL_REF ? (
            <img src={ursusBear} alt="" className="ursa-icon" />
          ) : modelRef ? (
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
            aria-disabled={!ursaSelectable}
            className={
              'menu-item ursa-entry' +
              (modelRef === URSA_MODEL_REF ? ' selected' : '') +
              (!ursaSelectable ? ' disabled' : '') +
              (flatOptions[activeIndex]?.id === 'model-ursa' ? ' active' : '')
            }
            onClick={() => {
              if (!ursaSelectable) return
              const idx = flatOptions.findIndex((o) => o.id === 'model-ursa')
              flatOptions[idx]?.commit()
            }}
            onMouseEnter={() => {
              if (ursaSelectable) {
                const idx = flatOptions.findIndex((o) => o.id === 'model-ursa')
                setActiveIndex(idx)
              }
            }}
          >
            <img src={ursaTeddy} alt="" className="ursa-icon" />
            <span>Ursa</span>
            {!ursaEnabled ? (
              <span className="ursa-hint">Enable Ursa in Settings first</span>
            ) : !anyProviderUsable ? (
              <span className="ursa-hint">Add an API key in Settings &gt; Providers first</span>
            ) : null}
            <span className="check">✓</span>
          </div>
          <div
            id="opt-model-ursus"
            role="option"
            aria-selected={modelRef === URSUS_MODEL_REF}
            aria-disabled={!ursusSelectable}
            className={
              'menu-item ursa-entry' +
              (modelRef === URSUS_MODEL_REF ? ' selected' : '') +
              (!ursusSelectable ? ' disabled' : '') +
              (flatOptions[activeIndex]?.id === 'model-ursus' ? ' active' : '')
            }
            onClick={() => {
              if (!ursusSelectable) return
              const idx = flatOptions.findIndex((o) => o.id === 'model-ursus')
              flatOptions[idx]?.commit()
            }}
            onMouseEnter={() => {
              if (ursusSelectable) {
                const idx = flatOptions.findIndex((o) => o.id === 'model-ursus')
                setActiveIndex(idx)
              }
            }}
          >
            <img src={ursusBear} alt="" className="ursa-icon" />
            <span>Ursus</span>
            {!ursusEnabled ? (
              <span className="ursa-hint">Enable Ursus in Settings first</span>
            ) : !(openrouterUsable || ollamaUsable) ? (
              <span className="ursa-hint">Add an OpenRouter key or run Ollama first</span>
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
