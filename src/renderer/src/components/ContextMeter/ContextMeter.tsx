import { useAppStore } from '../../state/store'
import { Hint } from '../Hint'
import { conversationTokens, contextUsage, contextWindowFor } from '../../lib/contextMeter'
import './ContextMeter.css'

export function ContextMeter(): React.JSX.Element | null {
  const view = useAppStore((s) => s.view)
  const conversations = useAppStore((s) => s.conversations)
  const providers = useAppStore((s) => s.providers)
  const modelRef = useAppStore((s) => s.modelRef)

  const convo = view.kind === 'conversation' ? conversations[view.id] : null
  const window = contextWindowFor(providers, modelRef)
  if (!convo || !window) return null

  const tokens = conversationTokens(convo.events)
  const { pct, near } = contextUsage(tokens, window)

  return (
    <Hint label={`~${tokens.toLocaleString()} of ${window.toLocaleString()} tokens (estimated)`} side="top">
      <span className={'context-meter' + (near ? ' near' : '') + (pct >= 100 ? ' over' : '')}>
        ~{pct}% context
      </span>
    </Hint>
  )
}
