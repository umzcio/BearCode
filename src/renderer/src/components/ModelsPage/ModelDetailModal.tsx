import { useRef, useState } from 'react'
import { useAppStore } from '../../state/store'
import { useAnimatedUnmount } from '../../lib/useAnimatedUnmount'
import { useModalDialog } from '../../lib/useModalDialog'
import { buildModelRows, formatTokens, MODE_LABEL } from '../../lib/modelRows'
import { relativeAge } from '../../lib/time'
import { ProviderIcon } from '../ProviderIcon'
import { Toggle } from '../Toggle'
import { Hint } from '../Hint'
import { Menu } from '../ui/Menu'
import { IconClose, IconCopy, IconDots, IconStar } from '../icons'
import './ModelDetailModal.css'

const STATUS_LABEL: Record<string, string> = {
  available: 'Available',
  'not-configured': 'Provider not configured',
  unavailable: 'Unavailable'
}

const CAPABILITY_LABELS: {
  key: 'functionCalling' | 'vision' | 'responseSchema' | 'reasoning' | 'webSearch'
  label: string
}[] = [
  { key: 'functionCalling', label: 'Function calling' },
  { key: 'vision', label: 'Vision' },
  { key: 'responseSchema', label: 'Structured output' },
  { key: 'reasoning', label: 'Reasoning' },
  { key: 'webSearch', label: 'Web search' }
]

// The Models page's popup detail view (not a docked rail -- that direction was
// mocked and explicitly rejected during design). Always rendered mounted by
// its caller only while a ref is selected; this component itself owns its
// exit animation via useAnimatedUnmount so a caller can flip to `null` and
// this still animates out.
export function ModelDetailModal({
  modelRef,
  onClose
}: {
  modelRef: string
  onClose: () => void
}): React.JSX.Element | null {
  const manageableModels = useAppStore((s) => s.manageableModels)
  const providers = useAppStore((s) => s.providers)
  const settings = useAppStore((s) => s.settings)
  const setModelEnabled = useAppStore((s) => s.setModelEnabled)
  const saveSettings = useAppStore((s) => s.saveSettings)
  const removeCustomModel = useAppStore((s) => s.removeCustomModel)
  const { mounted, state } = useAnimatedUnmount(true)
  const { ref: dialogRef, dialogProps } = useModalDialog(onClose)
  const menuBtnRef = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  const row = settings
    ? buildModelRows(manageableModels, providers, settings).find((r) => r.ref === modelRef)
    : undefined

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
              CAPABILITY_LABELS.map(({ key, label }) => (
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
