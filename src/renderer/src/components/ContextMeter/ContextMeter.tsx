import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../state/store'
import {
  conversationTokens,
  contextUsage,
  contextWindowFor,
  latestUsage,
  usageByModel,
  conversationCost
} from '../../lib/contextMeter'
import type { ProviderModels } from '@shared/types'
import './ContextMeter.css'

// Compact token count for the breakdown rows, e.g. 18200 → "18.2k".
function fmtK(n: number): string {
  return `${(n / 1000).toFixed(1)}k`
}

// A friendly model label from the providers list, falling back to the raw
// model id when the model isn't (or is no longer) in the provider catalog.
function labelFor(providers: ProviderModels[], provider: string, model: string): string {
  return (
    providers.find((p) => p.id === provider)?.models.find((m) => m.id === model)?.label ?? model
  )
}

const R = 7
const CIRC = 2 * Math.PI * R

// A small circular fill ring (like the AI providers) showing context-window
// usage; click it for the token detail.
export function ContextMeter(): React.JSX.Element | null {
  const view = useAppStore((s) => s.view)
  const conversations = useAppStore((s) => s.conversations)
  const providers = useAppStore((s) => s.providers)
  const modelRef = useAppStore((s) => s.modelRef)
  const modelPricing = useAppStore((s) => s.settings?.modelPricing)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return undefined
    const onDoc = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('click', onDoc)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', onDoc)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const convoId = view.kind === 'conversation' ? view.id : null
  const convo = convoId ? conversations[convoId] : null
  const ctxWindow = contextWindowFor(providers, modelRef)
  if (!convo || !convoId || !ctxWindow) return null

  // Prefer the provider's real last-turn prompt size; fall back to the char/4
  // estimate until any turn reports usage.
  const measuredTokens = latestUsage(convo.events)?.lastInputTokens ?? null
  const measured = measuredTokens !== null
  const tokens = measured ? measuredTokens : conversationTokens(convo.events)
  const { pct, near } = contextUsage(tokens, ctxWindow)
  const state = pct >= 100 ? 'over' : near ? 'near' : ''
  const offset = CIRC * (1 - Math.min(100, pct) / 100)

  // Per-model breakdown + cost — shown only once at least one turn has reported
  // measured usage (mirrors how the ring gates on a known context window).
  const byModel = usageByModel(convo.events)
  const cost = conversationCost(byModel, modelPricing)

  return (
    <div className="context-meter-wrap" ref={rootRef}>
      <button
        className={'context-ring ' + state}
        aria-label={`Context ${pct}% used`}
        title={`${measured ? '' : '~'}${pct}% context used`}
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">
          <circle className="ring-track" cx="9" cy="9" r={R} />
          <circle
            className="ring-fill"
            cx="9"
            cy="9"
            r={R}
            strokeDasharray={CIRC}
            strokeDashoffset={offset}
            transform="rotate(-90 9 9)"
          />
        </svg>
      </button>
      {open ? (
        <div className="menu context-popover">
          <div className="context-pop-row">
            <span className="context-pop-label">Context window</span>
            <span className="context-pop-pct">{pct}%</span>
          </div>
          <div className="context-pop-bar">
            <div
              className={'context-pop-bar-fill ' + state}
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </div>
          <div className="context-pop-sub">
            {measured ? '' : '~'}
            {tokens.toLocaleString()} of {ctxWindow.toLocaleString()} tokens (
            {measured ? 'measured' : 'estimated'})
          </div>
          {byModel.length > 0 ? (
            <>
              <div className="context-pop-divider" />
              <div className="context-pop-models">
                <div className="context-pop-models-head">By model</div>
                {byModel.map((m) => {
                  const c = cost.perModel[m.modelRef]
                  return (
                    <div className="context-pop-model-row" key={m.modelRef}>
                      <span className="context-pop-model-name">
                        {labelFor(providers, m.provider, m.model)}
                      </span>
                      <span className="context-pop-model-toks">
                        {fmtK(m.inputTokens)} in · {fmtK(m.outputTokens)} out
                      </span>
                      <span className="context-pop-model-cost">
                        {c === undefined ? '—' : `$${c.toFixed(2)}`}
                      </span>
                    </div>
                  )
                })}
              </div>
              <div className="context-pop-divider" />
              <div className="context-pop-total">
                <span className="context-pop-label">Total cost</span>
                <span className="context-pop-total-amt">${cost.total.toFixed(2)}</span>
              </div>
              {cost.hasUnknown ? <div className="context-pop-sub">+ unpriced models</div> : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
