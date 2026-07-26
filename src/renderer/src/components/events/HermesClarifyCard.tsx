import { useRef, useState } from 'react'
import type { Event } from '@shared/types'
import { useAppStore } from '../../state/store'
import { FieldHint } from '../ui/FieldHint'
import './events.css'

type HermesClarification = Extract<Event, { type: 'hermes_clarification' }>

export interface HermesClarifyCardProps {
  event: HermesClarification
  convoId: string
  interactive?: boolean
}

export function HermesClarifyCard({
  event,
  convoId,
  interactive = false
}: HermesClarifyCardProps): React.JSX.Element {
  const resolveHermesClarification = useAppStore((state) => state.resolveHermesClarification)
  const submittedRef = useRef(false)
  const [submitted, setSubmitted] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [otherOpen, setOtherOpen] = useState(false)
  const [otherText, setOtherText] = useState('')
  const canInteract = interactive && event.state === 'pending'
  const otherInvalid = otherText.trim().length === 0
  const inputId = `hermes-other-${event.id}`

  const submit = (response: string): void => {
    if (!canInteract || submittedRef.current || response.trim().length === 0) return
    submittedRef.current = true
    setSubmitted(true)
    setSubmitError(null)
    void resolveHermesClarification(convoId, event.requestId, response).catch(() => {
      submittedRef.current = false
      setSubmitted(false)
      setSubmitError('Could not submit response. Try again.')
    })
  }

  if (!canInteract) {
    return (
      <div className="step">
        <div className="step-row static">
          <span>
            <b>Clarification</b> · <span>{event.question}</span>
          </span>
        </div>
        <div className="waiting-note">
          {event.state === 'answered' && event.response
            ? `Answered: ${event.response}`
            : event.state === 'expired'
              ? 'This request ended before it was answered.'
              : event.choices.length > 0
                ? event.choices.join(' · ')
                : 'Waiting for a response…'}
        </div>
      </div>
    )
  }

  return (
    <div className="approval-card pulse-once clarify-card" id="pending-approval-card">
      <div className="approval-title">{event.question}</div>
      <div className="approval-actions" role="group" aria-label="Clarification choices">
        {event.choices.map((choice) => (
          <button
            key={choice}
            type="button"
            className="pill-btn"
            disabled={submitted}
            onClick={() => submit(choice)}
          >
            {choice}
          </button>
        ))}
        <button
          type="button"
          className="pill-btn"
          disabled={submitted}
          aria-expanded={otherOpen}
          onClick={() => setOtherOpen(true)}
        >
          Other
        </button>
      </div>
      {otherOpen ? (
        <form
          className="clarify-field"
          onSubmit={(formEvent) => {
            formEvent.preventDefault()
            submit(otherText.trim())
          }}
        >
          <label className="clarify-label" htmlFor={inputId}>
            Other response
          </label>
          <input
            id={inputId}
            className="set-input clarify-scope-input"
            type="text"
            required
            value={otherText}
            disabled={submitted}
            onChange={(changeEvent) => setOtherText(changeEvent.target.value)}
          />
          <FieldHint show={!submitted && otherInvalid}>Enter a response.</FieldHint>
          <button
            type="submit"
            className="pill-btn primary"
            disabled={submitted || otherInvalid}
          >
            Submit response
          </button>
        </form>
      ) : null}
      {submitError ? (
        <div className="waiting-note" role="alert">
          {submitError}
        </div>
      ) : null}
    </div>
  )
}
