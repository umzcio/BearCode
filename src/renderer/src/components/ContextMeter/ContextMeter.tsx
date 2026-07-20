import { useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../state/store'
import {
  conversationTokens,
  contextUsage,
  contextWindowFor,
  latestResolvedModelRef,
  latestUsage,
  usageByModel,
  conversationCost,
  costByRole
} from '../../lib/contextMeter'
import type { ProviderModels } from '@shared/types'
import { URSA_MODEL_REF, URSUS_MODEL_REF } from '@shared/types'
import { Popover } from '../ui/Popover'
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
  const convoId = view.kind === 'conversation' ? view.id : null
  const convo = useAppStore(
    useShallow((s) => {
      if (!convoId) return null
      const c = s.conversations[convoId]
      return c ? { events: c.events } : null
    })
  )
  const providers = useAppStore((s) => s.providers)
  const modelRef = useAppStore((s) => s.modelRef)
  const modelPricing = useAppStore((s) => s.settings?.modelPricing)
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // Router-driven conversations (Ursa/Ursus) keep the sentinel as the
  // conversation's own modelRef forever -- it's the picker selection, not
  // what actually ran a given turn -- so contextWindowFor can never resolve
  // it directly. Fall back to the latest turn's actual concrete model.
  const isRouterSentinel = modelRef === URSA_MODEL_REF || modelRef === URSUS_MODEL_REF
  const effectiveModelRef = isRouterSentinel
    ? (convo ? latestResolvedModelRef(convo.events) : null)
    : modelRef
  const ctxWindow = contextWindowFor(providers, effectiveModelRef)
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
  // Per-role spend (Ursa-routed conversations only) — empty otherwise.
  const byRole = costByRole(convo.events, modelPricing)

  return (
    <div className="context-meter-wrap">
      <button
        ref={triggerRef}
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
      <Popover
        anchorRef={triggerRef}
        open={open}
        onClose={() => setOpen(false)}
        placement="top-end"
      >
        <div className="menu menu--in-popover context-popover">
          <div className="context-pop-row">
            <span className="context-pop-label">Context window</span>
            <span className="context-pop-pct">{pct}%</span>
          </div>
          <div className="context-pop-bar">
            <div
              className={'context-pop-bar-fill ' + state}
              style={{ transform: `scaleX(${Math.min(100, pct) / 100})` }}
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
              {byRole.length > 0 ? (
                <>
                  <div className="context-pop-divider" />
                  <div className="context-pop-models context-pop-roles">
                    <div className="context-pop-models-head">By role</div>
                    {byRole.map((r) => (
                      <div className="context-pop-role-row" key={r.role}>
                        <span className="context-pop-role-name">{r.role}</span>
                        <span className="context-pop-role-cost">
                          {r.hasUnknown && r.cost === 0 ? '—' : `$${r.cost.toFixed(2)}`}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
              <div className="context-pop-divider" />
              <div className="context-pop-total">
                <span className="context-pop-label">Total cost</span>
                <span className="context-pop-total-amt">${cost.total.toFixed(2)}</span>
              </div>
              {cost.hasUnknown ? <div className="context-pop-sub">+ unpriced models</div> : null}
            </>
          ) : null}
        </div>
      </Popover>
    </div>
  )
}
