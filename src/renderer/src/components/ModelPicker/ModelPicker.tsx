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

// Favorites-first picker (approved prototype, 2026-08-13): opens on the
// ★ Favorites tab (Modes pinned on top), Recent derives from conversation
// history, All is the informed grouped list. The search field filters the
// ENTIRE catalog from any tab. Stars persist as settings.favoriteModels —
// the same list the Models tab's mt-fav stars edit.

const TABS = [
  { key: 'fav', label: '★ Favorites' },
  { key: 'rec', label: 'Recent' },
  { key: 'all', label: 'All' }
] as const
type TabKey = (typeof TABS)[number]['key']

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
  // Every open gets a fresh generation; tab/search/highlight are stored KEYED
  // to the generation and derived back to their defaults ('fav', '', current
  // model) whenever the stored generation is stale. This resets the picker on
  // each open without any setState-in-effect (react-hooks/set-state-in-effect).
  const [gen, setGen] = useState(0)
  const [tabSel, setTabSel] = useState<{ g: number; v: TabKey }>({ g: -1, v: 'fav' })
  const tab = tabSel.g === gen ? tabSel.v : 'fav'
  const setTab = (v: TabKey): void => setTabSel({ g: gen, v })
  const [searchSel, setSearchSel] = useState({ g: -1, v: '' })
  const search = searchSel.g === gen ? searchSel.v : ''
  const setSearch = (v: string): void => setSearchSel({ g: gen, v })
  // All-tab vendor rail selection: 'modes' (the bear) or a provider id.
  // Defaults to the current model's vendor so All opens where you are.
  const defaultRail: 'modes' | ProviderId =
    modelRef && modelRef !== URSA_MODEL_REF && modelRef !== URSUS_MODEL_REF
      ? (modelRef.slice(0, modelRef.indexOf('/')) as ProviderId)
      : 'modes'
  const [railSel, setRailSel] = useState<{ g: number; v: 'modes' | ProviderId }>({
    g: -1,
    v: 'modes'
  })
  const rail = railSel.g === gen ? railSel.v : defaultRail
  const setRail = (v: 'modes' | ProviderId): void => setRailSel({ g: gen, v })
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

  // The concrete model rows of the CURRENT view, in render order. The Ursa/
  // Ursus rows are prepended separately (they render on the Favorites tab and
  // in matching search results).
  const showModes = searching
    ? 'ursa ursus modes'.includes(q) || q.startsWith('urs')
    : tab === 'fav' || (tab === 'all' && rail === 'modes')
  const viewRefs: string[] = []
  if (searching) {
    for (const [ref, { provider, model }] of selectable) {
      const hay =
        `${model.label} ${provider.displayName} ${(model.strengths ?? []).join(' ')}`.toLowerCase()
      if (hay.includes(q)) viewRefs.push(ref)
    }
  } else if (tab === 'fav') {
    // The current model is always visible in the default view, favorited or
    // not — it carries the ✓ and seeds the keyboard highlight.
    if (
      modelRef &&
      modelRef !== URSA_MODEL_REF &&
      modelRef !== URSUS_MODEL_REF &&
      selectable.has(modelRef) &&
      !favoriteSet.has(modelRef)
    ) {
      viewRefs.push(modelRef)
    }
    for (const ref of favorites) if (selectable.has(ref)) viewRefs.push(ref)
  } else if (tab === 'rec') {
    viewRefs.push(...recents)
  } else if (rail !== 'modes') {
    // All tab, prototype-B pane: only the rail-selected vendor's models.
    for (const ref of selectable.keys()) if (ref.startsWith(`${rail}/`)) viewRefs.push(ref)
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
  for (const ref of viewRefs) {
    flatOptions.push({
      id: `model-${ref}`,
      commit: () => {
        selectModel(ref)
        setOpen(false)
      }
    })
  }
  // Add-key affordance renders in the All pane when the rail-selected vendor
  // has no key yet.
  if (!searching && tab === 'all' && rail !== 'modes') {
    const provider = providers.find((pr) => pr.id === rail)
    if (provider?.reachable && provider.requiresKey && !provider.keyConfigured) {
      flatOptions.push({
        id: `addkey-${provider.id}`,
        commit: () => {
          setOpen(false)
          openSettings('providers')
        }
      })
    }
  }

  // The roving highlight, same generation-keyed derivation: until the user
  // arrows/hovers within this view (gen + tab + search), the highlight sits on
  // the current model (or the first row).
  const viewKey = `${gen}:${tab}:${rail}:${search}`
  const [activeSel, setActiveSel] = useState({ k: '', i: 0 })
  const currentTargetId =
    modelRef === URSA_MODEL_REF
      ? 'model-ursa'
      : modelRef === URSUS_MODEL_REF
        ? 'model-ursus'
        : `model-${modelRef}`
  const seedIndex = Math.max(
    0,
    flatOptions.findIndex((o) => o.id === currentTargetId)
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

  const modelRow = (ref: string): React.JSX.Element | null => {
    const entry = selectable.get(ref)
    if (!entry) return null
    const { provider, model } = entry
    const idx = flatOptions.findIndex((o) => o.id === `model-${ref}`)
    const ctx = formatCtx(model.contextWindow)
    const price = settings?.modelPricing?.[ref]?.inputPer1M
    const tier = provider.id === 'ollama' ? 'free' : costTier(price)
    const fav = favoriteSet.has(ref)
    return (
      <div
        key={ref}
        id={`opt-model-${ref}`}
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
          {!searching ? (
            <div className="mpk-tabs" role="tablist">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  className={'mpk-tab' + (tab === t.key ? ' on' : '')}
                  onClick={() => setTab(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          ) : null}
          <div className={'mpk-scroll' + (!searching && tab === 'all' ? ' mpk-scroll--split' : '')}>
            {searching ? (
              <>
                {ursaRow}
                {ursusRow}
                {viewRefs.length === 0 && !showModes ? (
                  <div className="mpk-empty">No models match “{search.trim()}”</div>
                ) : (
                  viewRefs.map(modelRow)
                )}
              </>
            ) : tab === 'fav' ? (
              <>
                <div className="menu-group-label">Modes</div>
                {ursaRow}
                {ursusRow}
                <div className="menu-group-label">Favorites</div>
                {viewRefs.length > 0 ? (
                  viewRefs.map(modelRow)
                ) : (
                  <div className="mpk-empty">
                    <b>No favorites yet</b>
                    Hover any model in All and click the ★ to keep it here.
                  </div>
                )}
              </>
            ) : tab === 'rec' ? (
              viewRefs.length > 0 ? (
                <>
                  <div className="menu-group-label">Recently used</div>
                  {viewRefs.map(modelRow)}
                </>
              ) : (
                <div className="mpk-empty">
                  <b>Nothing yet</b>
                  Models you use show up here automatically.
                </div>
              )
            ) : (
              (() => {
                // Prototype-B pane inside the All tab: vendor rail on the
                // left (bear = Modes), the selected vendor's models on the
                // right. The tab strip above never changes.
                const railProvider = rail === 'modes' ? null : providers.find((p) => p.id === rail)
                const dimmed =
                  railProvider != null && railProvider.requiresKey && !railProvider.keyConfigured
                return (
                  <div className="mpk-all">
                    <div className="mpk-rail">
                      <button
                        type="button"
                        className={'mpk-rail-btn' + (rail === 'modes' ? ' on' : '')}
                        aria-label="Modes"
                        title="Modes"
                        onClick={() => setRail('modes')}
                      >
                        <img src={ursaTeddy} alt="" className="ursa-icon" />
                      </button>
                      {providers.map((p) =>
                        p.reachable || p.note ? (
                          <button
                            key={p.id}
                            type="button"
                            className={'mpk-rail-btn' + (rail === p.id ? ' on' : '')}
                            aria-label={p.displayName}
                            title={p.displayName}
                            onClick={() => setRail(p.id)}
                          >
                            <ProviderIcon provider={p.id} size={16} />
                          </button>
                        ) : null
                      )}
                    </div>
                    <div className="mpk-pane">
                      {rail === 'modes' ? (
                        <>
                          <div className="menu-group-label">Modes</div>
                          {ursaRow}
                          {ursusRow}
                        </>
                      ) : railProvider == null || (!railProvider.reachable && railProvider.note) ? (
                        <>
                          <div className="menu-group-label">{railProvider?.displayName ?? ''}</div>
                          <div className="menu-item disabled">
                            <span>{railProvider?.note ?? 'Not reachable'}</span>
                          </div>
                        </>
                      ) : dimmed ? (
                        <>
                          <div className="menu-group-label">{railProvider.displayName}</div>
                          {(() => {
                            const idx = flatOptions.findIndex(
                              (o) => o.id === `addkey-${railProvider.id}`
                            )
                            return (
                              <div
                                id={`opt-addkey-${railProvider.id}`}
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
                          })()}
                        </>
                      ) : (
                        <>
                          <div className="menu-group-label">{railProvider.displayName}</div>
                          {viewRefs.map(modelRow)}
                        </>
                      )}
                    </div>
                  </div>
                )
              })()
            )}
          </div>
        </div>
      </Popover>
    </div>
  )
}
