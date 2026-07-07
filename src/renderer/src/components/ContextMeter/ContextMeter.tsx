import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../state/store'
import { conversationTokens, contextUsage, contextWindowFor } from '../../lib/contextMeter'
import './ContextMeter.css'

const R = 7
const CIRC = 2 * Math.PI * R

// A small circular fill ring (like the AI providers) showing context-window
// usage; click it for the token detail.
export function ContextMeter(): React.JSX.Element | null {
  const view = useAppStore((s) => s.view)
  const conversations = useAppStore((s) => s.conversations)
  const providers = useAppStore((s) => s.providers)
  const modelRef = useAppStore((s) => s.modelRef)
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

  const convo = view.kind === 'conversation' ? conversations[view.id] : null
  const ctxWindow = contextWindowFor(providers, modelRef)
  if (!convo || !ctxWindow) return null

  const tokens = conversationTokens(convo.events)
  const { pct, near } = contextUsage(tokens, ctxWindow)
  const state = pct >= 100 ? 'over' : near ? 'near' : ''
  const offset = CIRC * (1 - Math.min(100, pct) / 100)

  return (
    <div className="context-meter-wrap" ref={rootRef}>
      <button
        className={'context-ring ' + state}
        aria-label={`Context ${pct}% used`}
        title={`~${pct}% context used`}
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
            ~{tokens.toLocaleString()} of {ctxWindow.toLocaleString()} tokens (estimated)
          </div>
        </div>
      ) : null}
    </div>
  )
}
