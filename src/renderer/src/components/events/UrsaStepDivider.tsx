import type { Event } from '@shared/types'
import { useAppStore, modelDisplay } from '../../state/store'
import './events.css'

type UrsaStepEvent = Extract<Event, { type: 'ursa_step' }>

// Ursa Phase 2: a slim divider row emitted before each step of an approved
// multi-role pipeline drives -- "Step 2/3 · reviewer · Claude Sonnet 5" with
// the Ursa accent. Purely presentational; no animation (reduce-motion safe by
// construction, like CompactionMarker). The model name resolves through the
// same modelDisplay the hover badge uses, so an unknown ref degrades to the
// raw model id rather than rendering blank.
export function UrsaStepDivider({ event }: { event: UrsaStepEvent }): React.JSX.Element {
  const providers = useAppStore((s) => s.providers)
  const model = modelDisplay(providers, event.modelRef).name
  const label = `Step ${event.index}/${event.total} · ${event.role} · ${model}`
  return (
    <div className="ursa-step" role="separator" aria-label={label}>
      <span className="ursa-step-badge">{event.index}</span>
      <span className="ursa-step-label">
        Step {event.index}/{event.total}
      </span>
      <span className="ursa-step-role">{event.role}</span>
      <span className="ursa-step-sep">·</span>
      <span className="ursa-step-model">{model}</span>
      <span className="ursa-step-rule" aria-hidden="true" />
    </div>
  )
}
