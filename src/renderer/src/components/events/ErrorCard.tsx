import { memo } from 'react'
import './events.css'

function ErrorCardImpl({
  message,
  recoverable,
  onRetry
}: {
  message: string
  recoverable: boolean
  onRetry(): void
}): React.JSX.Element {
  return (
    <div className="error-card">
      <span className="error-msg">{message}</span>
      {recoverable ? (
        <button className="retry-btn" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  )
}
export const ErrorCard = memo(ErrorCardImpl)
