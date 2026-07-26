import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../state/store'
import { useAnimatedUnmount } from '../../lib/useAnimatedUnmount'
import { useModalDialog } from '../../lib/useModalDialog'
import {
  buildModelRows,
  formatTokens,
  MODE_LABEL,
  CAPABILITY_LABEL,
  STATUS_LABEL,
  type CapabilityKey
} from '../../lib/modelRows'
import { relativeAge } from '../../lib/time'
import { ProviderIcon } from '../ProviderIcon'
import { Toggle } from '../Toggle'
import { Hint } from '../Hint'
import { Menu } from '../ui/Menu'
import { IconClose, IconCopy, IconDots, IconStar } from '../icons'
import './ModelDetailModal.css'

// The Models page's popup detail view (not a docked rail -- that direction was
// mocked and explicitly rejected during design). Always rendered mounted by
// its caller; drives its own open/close purely off `modelRef` going null <->
// a real ref, so a caller that flips `modelRef` to `null` sees it animate out
// instead of vanishing instantly.
export function ModelDetailModal({
  modelRef,
  onClose
}: {
  modelRef: string | null
  onClose: () => void
}): React.JSX.Element | null {
  const manageableModels = useAppStore((s) => s.manageableModels)
  const providers = useAppStore((s) => s.providers)
  const settings = useAppStore((s) => s.settings)
  const setModelEnabled = useAppStore((s) => s.setModelEnabled)
  const saveSettings = useAppStore((s) => s.saveSettings)
  const removeCustomModel = useAppStore((s) => s.removeCustomModel)
  const { mounted, state } = useAnimatedUnmount(modelRef != null)
  const { ref: dialogRef, dialogProps } = useModalDialog(onClose)
  const menuBtnRef = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  const freshRow = settings
    ? buildModelRows(manageableModels, providers, settings).find((r) => r.ref === modelRef)
    : undefined

  // `modelRef` (and therefore `freshRow`) goes null the instant the modal
  // starts closing, but the panel must keep rendering its last content while
  // it fades out -- retain the last known row across that window (mirrors
  // ProjectSettingsModal's `lastFolder` pattern). A plain ref (mutated during
  // render, read in the same pass) rather than state: `buildModelRows`
  // returns a brand-new row object every render even when the underlying
  // data hasn't changed, so comparing by state would never settle and would
  // loop forever re-rendering.
  const lastRowRef = useRef(freshRow)
  if (freshRow) lastRowRef.current = freshRow
  const row = freshRow ?? lastRowRef.current

  // Esc closes only this modal, not any modal behind it (mirrors
  // BrowseSmitheryModal.tsx's identical pattern): intercept in the CAPTURE
  // phase and stop propagation. The listener is only added while mounted.
  useEffect(() => {
    if (!mounted) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [mounted, onClose])

  if (!mounted || !settings || !row) return null

  const toggleFavorite = (): void => {
    const set = new Set(settings.favoriteModels ?? [])
    if (set.has(row.ref)) set.delete(row.ref)
    else set.add(row.ref)
    void saveSettings({ favoriteModels: [...set] })
  }

  return (
    <div
      className="modal-overlay open"
      data-state={state}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="model-detail-panel"
        data-state={state}
        ref={dialogRef}
        {...dialogProps}
        aria-label={`${row.label} details`}
      >
        <div className="mdp-head">
          <ProviderIcon provider={row.providerId} size={22} />
          <div className="mdp-headtext">
            <div className="mdp-name">{row.label}</div>
            <div className="mdp-vendor">{row.providerDisplayName}</div>
          </div>
          <Toggle
            checked={row.enabled}
            ariaLabel={`${row.label} enabled`}
            onChange={(on) => void setModelEnabled(row.ref, on)}
          />
          <Hint label={row.favorite ? 'Unfavorite' : 'Favorite'}>
            <button
              type="button"
              className={'mdp-icon-btn' + (row.favorite ? ' active' : '')}
              aria-label={row.favorite ? 'Unfavorite' : 'Favorite'}
              onClick={toggleFavorite}
            >
              <IconStar size={16} />
            </button>
          </Hint>
          {row.custom ? (
            <>
              <Hint label="More actions">
                <button
                  ref={menuBtnRef}
                  type="button"
                  className="mdp-icon-btn"
                  aria-label="More actions"
                  onClick={() => setMenuOpen((o) => !o)}
                >
                  <IconDots size={16} />
                </button>
              </Hint>
              <Menu
                anchorRef={menuBtnRef}
                open={menuOpen}
                onClose={() => setMenuOpen(false)}
                groups={[{ items: [{ value: 'remove', label: 'Remove custom model', danger: true }] }]}
                onSelect={() => {
                  void removeCustomModel(row.providerId, row.id)
                  setMenuOpen(false)
                  onClose()
                }}
                ariaLabel="Model actions"
                placement="bottom-end"
              />
            </>
          ) : null}
          <Hint label="Close" side="bottom">
            <button type="button" className="mdp-icon-btn" aria-label="Close" onClick={onClose}>
              <IconClose size={16} />
            </button>
          </Hint>
        </div>

        <div className="mdp-body">
          {row.catalog?.description ? <div className="mdp-desc">{row.catalog.description}</div> : null}
          {row.catalog?.tags?.length ? (
            <div className="mdp-tags">
              {row.catalog.tags.map((t) => (
                <span className="chip" key={t}>
                  {t}
                </span>
              ))}
            </div>
          ) : null}

          <div className="mdp-row">
            <span className="mdp-label">Model ID</span>
            <span className="mdp-mono">
              {row.ref}
              <button
                type="button"
                className="mdp-copy"
                aria-label="Copy model ID"
                onClick={() => void navigator.clipboard.writeText(row.ref)}
              >
                <IconCopy size={13} />
              </button>
            </span>
          </div>

          <div className="mdp-stats">
            <div className="mdp-stat">
              <span className="mdp-stat-label">Type</span>
              <span className="mdp-stat-value">
                {row.metadata ? MODE_LABEL[row.metadata.mode] : 'Unknown'}
              </span>
            </div>
            <div className="mdp-stat">
              <span className="mdp-stat-label">Context window</span>
              <span className="mdp-stat-value">{formatTokens(row.contextWindow)}</span>
            </div>
            <div className="mdp-stat">
              <span className="mdp-stat-label">Max output</span>
              <span className="mdp-stat-value">{formatTokens(row.metadata?.maxOutputTokens)}</span>
            </div>
          </div>

          <div className="mdp-caps">
            {row.metadata ? (
              (Object.entries(CAPABILITY_LABEL) as [CapabilityKey, string][]).map(([key, label]) => (
                <span
                  className={'mdp-cap' + (row.metadata!.capabilities[key] ? ' on' : '')}
                  key={key}
                >
                  {label}
                </span>
              ))
            ) : (
              <span className="mdp-cap-unknown">Capabilities unknown (not in LiteLLM's catalog)</span>
            )}
          </div>

          <div className="mdp-row">
            <span className="mdp-label">Pricing</span>
            <span className="mdp-value">
              {row.price
                ? `$${row.price.inputPer1M} in / $${row.price.outputPer1M} out per 1M tokens`
                : 'Unknown'}
            </span>
          </div>

          <div className="mdp-row">
            <span className="mdp-label">Status</span>
            <span className="mdp-value">
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
            </span>
          </div>

          <div className="mdp-source">
            Source: LiteLLM
            {settings.modelPricingSyncedAt
              ? ` · synced ${relativeAge(settings.modelPricingSyncedAt)}`
              : ' · not yet synced'}
          </div>
        </div>
      </div>
    </div>
  )
}
