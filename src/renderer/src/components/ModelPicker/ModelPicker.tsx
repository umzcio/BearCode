import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ModelInfo, ProviderId, ProviderModels } from '@shared/types'
import { URSA_MODEL_REF, URSUS_MODEL_REF } from '@shared/types'
import { modelDisplay, useAppStore } from '../../state/store'
import { ProviderIcon } from '../ProviderIcon'
import { Hint } from '../Hint'
import { IconChevronDown, IconSearch } from '../icons'
import { Popover } from '../ui/Popover'
import ursaTeddy from '../../assets/ursa-teddy.svg'
import ursusTeddy from '../../assets/ursus-teddy.svg'
import { useCloseOnSettingsOpen } from '../../lib/useCloseOnSettingsOpen'
import './ModelPicker.css'

// Informed-list picker (option D + search + favorites, per Zach 2026-08-13):
// ONE continuous scrolling list — Modes, ★ Favorites (the landing view),
// Recent, then the ENTIRE vendor-grouped catalog with informed rows. No tabs:
// the full list is always present, favorites are simply where you land. The
// search field filters the whole catalog. Stars persist as
// settings.favoriteModels — the same list the Models tab's mt-fav stars edit.

// 1_000_000 -> "1M", 200_000 -> "200K".
function formatCtx(n: number | undefined): string | null {
  if (!n || n <= 0) return null
  if (n >= 1_000_000) return `${Math.round((n / 1_000_000) * 10) / 10}M`
  return `${Math.round(n / 1_000)}K`
}

// Cost tier from the synced per-1M input price; null hides the tag.
function costTier(inputPer1M: number | undefined): '$' | '$$' | '$$$' | null {
  if (inputPer1M == null) return null
  if (inputPer1M < 1) return '$'
  if (inputPer1M < 8) return '$$'
  return '$$$'
}

export function ModelPicker(): React.JSX.Element {
  const providers = useAppStore((s) => s.providers)
  const modelRef = useAppStore((s) => s.modelRef)
  const selectModel = useAppStore((s) => s.selectModel)
  const openSettings = useAppStore((s) => s.openSettings)
  const modelMenuTick = useAppStore((s) => s.modelMenuTick)
  const settings = useAppStore((s) => s.settings)
  const saveSettings = useAppStore((s) => s.saveSettings)
  const conversations = useAppStore((s) => s.conversations)
  // Ursa's roles are curated in code (main/orchestrator/ursa.ts), not user
  // data -- the renderer only needs to know whether Ursa is turned on and
  // whether at least one provider is usable at all, not which specific
  // curated roles exist (that would duplicate CURATED_ROLES across the
  // Electron process boundary for no benefit).
  const ursaEnabled = settings?.ursaEnabled === true
  const anyProviderUsable = providers.some(
    (p) => p.reachable && (!p.requiresKey || p.keyConfigured)
  )
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
  // Every open gets a fresh generation; search/highlight are stored KEYED to
  // the generation and derived back to their defaults ('', current model)
  // whenever the stored generation is stale. This resets the picker on each
  // open without any setState-in-effect (react-hooks/set-state-in-effect).
  const [gen, setGen] = useState(0)
  const [searchSel, setSearchSel] = useState({ g: -1, v: '' })
  const search = searchSel.g === gen ? searchSel.v : ''
  const setSearch = (v: string): void => setSearchSel({ g: gen, v })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const lastTick = useRef(modelMenuTick)

  const current = modelDisplay(providers, modelRef)
  const favorites = settings?.favoriteModels ?? []
  const favoriteSet = new Set(favorites)

  // Selectable concrete models, keyed by ref, in provider order.
  const selectable = new Map<string, { provider: ProviderModels; model: ModelInfo }>()
  for (const provider of providers) {
    if (!provider.reachable || (provider.requiresKey && !provider.keyConfigured)) continue
    for (const model of provider.models) {
      selectable.set(`${provider.id}/${model.id}`, { provider, model })
    }
  }

  // Recent = distinct concrete modelRefs from conversation history, newest
  // first, still-selectable only. Routers are excluded — they live pinned on
  // the Favorites tab.
  const recents: string[] = []
  if (open) {
    const convos = Object.values(conversations)
      .filter((c) => c.modelRef && c.updatedAt)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    for (const c of convos) {
      const ref = c.modelRef as string
      if (!selectable.has(ref) || recents.includes(ref)) continue
      recents.push(ref)
      if (recents.length >= 6) break
    }
  }

  const searching = search.trim().length > 0
  const q = search.trim().toLowerCase()

  const showModes = searching ? 'ursa ursus modes'.includes(q) || q.startsWith('urs') : true
  // Section contents (one continuous list; a model may appear in several
  // sections, so row ids carry a section prefix to stay unique).
  const favRefs = favorites.filter((ref) => selectable.has(ref))
  const recRefs = recents.filter((ref) => !favoriteSet.has(ref))
  const searchRefs: string[] = []
  if (searching) {
    for (const [ref, { provider, model }] of selectable) {
      const hay =
        `${model.label} ${provider.displayName} ${(model.strengths ?? []).join(' ')}`.toLowerCase()
      if (hay.includes(q)) searchRefs.push(ref)
    }
  }

  // Flatten the visible view into the navigable options, in the same order
  // they render, so keyboard nav and the mouse click handlers commit the
  // identical action.
  const flatOptions: { id: string; commit: () => void }[] = []
  if (showModes && ursaSelectable) {
    flatOptions.push({
      id: 'model-ursa',
      commit: () => {
        selectModel(URSA_MODEL_REF)
        setOpen(false)
      }
    })
  }
  if (showModes && ursusSelectable) {
    flatOptions.push({
      id: 'model-ursus',
      commit: () => {
        selectModel(URSUS_MODEL_REF)
        setOpen(false)
      }
    })
  }
  const pushModel = (section: string, ref: string): void => {
    flatOptions.push({
      id: `model-${section}-${ref}`,
      commit: () => {
        selectModel(ref)
        setOpen(false)
      }
    })
  }
  if (searching) {
    for (const ref of searchRefs) pushModel('hit', ref)
  } else {
    for (const ref of favRefs) pushModel('fav', ref)
    for (const ref of recRefs) pushModel('rec', ref)
    for (const [ref] of selectable) pushModel('all', ref)
    for (const provider of providers) {
      if (provider.reachable && provider.requiresKey && !provider.keyConfigured) {
        flatOptions.push({
          id: `addkey-${provider.id}`,
          commit: () => {
            setOpen(false)
            openSettings('providers')
          }
        })
      }
    }
  }

  // The roving highlight, same generation-keyed derivation: until the user
  // arrows/hovers within this view (gen + tab + search), the highlight sits on
  // the current model (or the first row).
  const viewKey = `${gen}:${search}`
  const [activeSel, setActiveSel] = useState({ k: '', i: 0 })
  const seedIndex = Math.max(
    0,
    modelRef === URSA_MODEL_REF
      ? flatOptions.findIndex((o) => o.id === 'model-ursa')
      : modelRef === URSUS_MODEL_REF
        ? flatOptions.findIndex((o) => o.id === 'model-ursus')
        : flatOptions.findIndex((o) => o.id.endsWith(`-${modelRef}`))
  )
  const activeIndex = activeSel.k === viewKey ? activeSel.i : seedIndex
  const setActiveIndex = (i: number | ((prev: number) => number)): void =>
    setActiveSel((prev) => ({
      k: viewKey,
      i: typeof i === 'function' ? i(prev.k === viewKey ? prev.i : seedIndex) : i
    }))

  // Cmd+/ toggles the menu. Compare against the last seen tick so this only
  // fires on a real tick change, not on mount or StrictMode's double-run.
  useEffect(() => {
    if (lastTick.current === modelMenuTick) return
    lastTick.current = modelMenuTick
    setOpen((o) => !o)
    setGen((g) => g + 1)
  }, [modelMenuTick])

  // Popover owns click-outside/Esc/scroll dismissal + positioning. This
  // effect only focuses the search field so typing filters immediately while
  // arrow keys still navigate -- stays a useLayoutEffect (not useEffect)
  // because Popover measures + positions itself in its own useLayoutEffect on
  // the same open transition, and layout effects fire bottom-up, so the field
  // is never `visibility: hidden` when `.focus()` is called (Chromium
  // silently no-ops focus on a hidden element). See Popover.tsx.
  useLayoutEffect(() => {
    if (open) searchRef.current?.focus()
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
    } else if (e.key === 'Enter') {
      e.preventDefault()
      flatOptions[activeIndex]?.commit()
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  const toggleFavorite = (ref: string): void => {
    const set = new Set(favorites)
    if (set.has(ref)) set.delete(ref)
    else set.add(ref)
    void saveSettings({ favoriteModels: [...set] })
  }

  const modeRow = (
    kind: 'ursa' | 'ursus',
    isSelectable: boolean,
    icon: string,
    label: string,
    hint: string | null
  ): React.JSX.Element => {
    const id = `model-${kind}`
    const sentinel = kind === 'ursa' ? URSA_MODEL_REF : URSUS_MODEL_REF
    const idx = flatOptions.findIndex((o) => o.id === id)
    return (
      <div
        id={`opt-${id}`}
        role="option"
        aria-selected={modelRef === sentinel}
        aria-disabled={!isSelectable}
        className={
          'menu-item ursa-entry' +
          (modelRef === sentinel ? ' selected' : '') +
          (!isSelectable ? ' disabled' : '') +
          (flatOptions[activeIndex]?.id === id ? ' active' : '')
        }
        onClick={() => {
          if (isSelectable) flatOptions[idx]?.commit()
        }}
        onMouseEnter={() => {
          if (isSelectable && idx >= 0) setActiveIndex(idx)
        }}
      >
        <img src={icon} alt="" className="ursa-icon" />
        <span>{label}</span>
        {hint ? <span className="ursa-hint">{hint}</span> : null}
        <span className="check">✓</span>
      </div>
    )
  }

  const modelRow = (section: string, ref: string): React.JSX.Element | null => {
    const entry = selectable.get(ref)
    if (!entry) return null
    const { provider, model } = entry
    const idx = flatOptions.findIndex((o) => o.id === `model-${section}-${ref}`)
    const ctx = formatCtx(model.contextWindow)
    const price = settings?.modelPricing?.[ref]?.inputPer1M
    const tier = provider.id === 'ollama' ? 'free' : costTier(price)
    const fav = favoriteSet.has(ref)
    return (
      <div
        key={`${section}:${ref}`}
        id={`opt-model-${section}-${ref}`}
        role="option"
        aria-selected={ref === modelRef}
        className={
          'menu-item mpk-row' +
          (ref === modelRef ? ' selected' : '') +
          (idx === activeIndex ? ' active' : '')
        }
        onClick={() => flatOptions[idx]?.commit()}
        onMouseEnter={() => setActiveIndex(idx)}
      >
        <ProviderIcon provider={provider.id} size={16} />
        <span className="mpk-nm">
          <b>{model.label}</b>
          {model.strengths?.length ? <small>{model.strengths.join(' · ')}</small> : null}
        </span>
        <button
          type="button"
          className={'mpk-star' + (fav ? ' on' : '')}
          aria-label={fav ? `Unfavorite ${model.label}` : `Favorite ${model.label}`}
          aria-pressed={fav}
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation()
            toggleFavorite(ref)
          }}
        >
          ★
        </button>
        <span className="mpk-tags">
          {ctx ? <span className="mpk-tag">{ctx}</span> : null}
          {tier ? (
            <span
              className={
                'mpk-tag' + (tier === '$' || tier === 'free' ? ' g' : tier === '$$$' ? ' o' : '')
              }
            >
              {tier}
            </span>
          ) : null}
        </span>
        <span className="check">✓</span>
      </div>
    )
  }

  const ursaRow = showModes
    ? modeRow(
        'ursa',
        ursaSelectable,
        ursaTeddy,
        'Ursa',
        !ursaEnabled
          ? 'Enable Ursa in Settings first'
          : !anyProviderUsable
            ? 'Add an API key in Settings > Providers first'
            : null
      )
    : null
  const ursusRow = showModes
    ? modeRow(
        'ursus',
        ursusSelectable,
        ursusTeddy,
        'Ursus',
        !ursusEnabled
          ? 'Enable Ursus in Settings first'
          : !(openrouterUsable || ollamaUsable)
            ? 'Add an OpenRouter key or run Ollama first'
            : null
      )
    : null

  return (
    <div className="model-picker">
      <Hint label="Select Model" keys="⌘/" side="top" disabled={open}>
        <button
          ref={triggerRef}
          className="pill-btn"
          onClick={() => {
            setOpen((o) => !o)
            setGen((g) => g + 1)
          }}
        >
          {modelRef === URSA_MODEL_REF ? (
            <img src={ursaTeddy} alt="" className="ursa-icon" />
          ) : modelRef === URSUS_MODEL_REF ? (
            <img src={ursusTeddy} alt="" className="ursa-icon" />
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
          <div className="menu-search mpk-search">
            <IconSearch />
            <input
              ref={searchRef}
              placeholder="Search models…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
          <div className="mpk-scroll">
            {searching ? (
              <>
                {ursaRow}
                {ursusRow}
                {searchRefs.length === 0 && !showModes ? (
                  <div className="mpk-empty">No models match “{search.trim()}”</div>
                ) : (
                  searchRefs.map((ref) => modelRow('hit', ref))
                )}
              </>
            ) : (
              <>
                {/* Option D, one continuous list: Modes, then ★ Favorites as
                    the landing section, Recent, then the ENTIRE informed
                    catalog grouped by vendor. Nothing hides behind a tab. */}
                <div className="menu-group-label">Modes</div>
                {ursaRow}
                {ursusRow}
                <div className="menu-group-label">★ Favorites</div>
                {favRefs.length > 0 ? (
                  favRefs.map((ref) => modelRow('fav', ref))
                ) : (
                  <div className="mpk-empty">
                    <b>No favorites yet</b>
                    Hover any model below and click the ★ to pin it up here.
                  </div>
                )}
                {recRefs.length > 0 ? (
                  <>
                    <div className="menu-group-label">Recent</div>
                    {recRefs.map((ref) => modelRow('rec', ref))}
                  </>
                ) : null}
                {providers.map((provider) => {
                  const dimmed = provider.requiresKey && !provider.keyConfigured
                  if (!provider.reachable && !provider.note) return null
                  return (
                    <div key={provider.id}>
                      <div className="menu-group-label">
                        <span className="group-icon">
                          <ProviderIcon provider={provider.id} size={14} />
                        </span>
                        {provider.displayName}
                      </div>
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
                              className={
                                'menu-item add-key' + (idx === activeIndex ? ' active' : '')
                              }
                              onClick={() => flatOptions[idx]?.commit()}
                              onMouseEnter={() => setActiveIndex(idx)}
                            >
                              <span>Add API key</span>
                            </div>
                          )
                        })()
                      ) : (
                        provider.models.map((model) =>
                          modelRow('all', `${provider.id}/${model.id}`)
                        )
                      )}
                    </div>
                  )
                })}
              </>
            )}
          </div>
        </div>
      </Popover>
    </div>
  )
}
