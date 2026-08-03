import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BrowserStatus } from '@shared/types'
import { EmptyState } from '../ui/EmptyState'
import { ErrorCard } from '../ui/ErrorCard'
import { Loading } from '../ui/Loading'
import './BrowserPane.css'

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.split('\n')[0]
  return 'Browser control is unavailable.'
}

// F4: the in-app browser pane. This is a placeholder rect only -- the real
// pixels come from a main-side WebContentsView positioned over this element.
// `visible` already combines shell visibility + motion settlement upstream.
export function BrowserPane({
  visible,
  hideRequest = null,
  onHideSettled
}: {
  visible: boolean
  hideRequest?: number | null
  onHideSettled?: (request: number) => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const mountedRef = useRef(true)
  const presentationRevisionRef = useRef(0)
  const visibilityAttemptRef = useRef(0)
  const boundsAttemptRef = useRef(0)
  const [presentationRevision, setPresentationRevision] = useState(0)
  const [hideConfirmedRevision, setHideConfirmedRevision] = useState<number | null>(null)
  const [status, setStatus] = useState<BrowserStatus | null>(null)
  const [pendingError, setPendingError] = useState<string | null>(null)
  const [commandError, setCommandError] = useState<string | null>(null)

  const queueFailure = useCallback((error: unknown, isCurrent: () => boolean): void => {
    if (!mountedRef.current || !isCurrent()) return
    const revision = ++presentationRevisionRef.current
    visibilityAttemptRef.current += 1
    setPresentationRevision(revision)
    setHideConfirmedRevision(null)
    setPendingError(errorMessage(error))
    setCommandError(null)
  }, [])

  // Clamped into the window: during the pane's entrance the shell is
  // transform-translated partially past the window edge (and fractional zoom
  // coordinates can round 1px past it), and the main-process bounds guard
  // hard-rejects any out-of-window rect — one rejection wedges the pane in an
  // ErrorCard. A degenerate result (zero-size / fully outside) returns null so
  // the push is skipped; the settle-gated effect re-measures at rest.
  const measuredBounds = useCallback(() => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return null
    const x = Math.min(Math.max(0, Math.round(rect.x)), window.innerWidth)
    const y = Math.min(Math.max(0, Math.round(rect.y)), window.innerHeight)
    const width = Math.min(Math.round(rect.width), window.innerWidth - x)
    const height = Math.min(Math.round(rect.height), window.innerHeight - y)
    if (width < 1 || height < 1) return null
    return { x, y, width, height }
  }, [])

  const pushBounds = useCallback((): void => {
    const bounds = measuredBounds()
    if (!bounds) return
    const attempt = ++boundsAttemptRef.current
    const revision = presentationRevisionRef.current
    void window.bearcode.browser.setBounds(bounds).catch((error: unknown) => {
      queueFailure(
        error,
        () => attempt === boundsAttemptRef.current && revision === presentationRevisionRef.current
      )
    })
  }, [measuredBounds, queueFailure])

  // Subscribe before invoking status(). A pushed status increments the revision,
  // making any later initial result/rejection stale and therefore harmless.
  useEffect(() => {
    mountedRef.current = true
    const applyStatus = (next: BrowserStatus): void => {
      const revision = ++presentationRevisionRef.current
      visibilityAttemptRef.current += 1
      setPresentationRevision(revision)
      setHideConfirmedRevision(null)
      setPendingError(null)
      setCommandError(null)
      setStatus(next)
    }
    const initialRevision = presentationRevisionRef.current
    const unsubscribe = window.bearcode.browser.onStatus(applyStatus)
    void window.bearcode.browser.status().then(
      (initial) => {
        if (mountedRef.current && presentationRevisionRef.current === initialRevision) {
          applyStatus(initial)
        }
      },
      (error: unknown) => {
        queueFailure(error, () => presentationRevisionRef.current === initialRevision)
      }
    )
    return () => {
      mountedRef.current = false
      presentationRevisionRef.current += 1
      visibilityAttemptRef.current += 1
      boundsAttemptRef.current += 1
      unsubscribe()
    }
  }, [queueFailure])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    pushBounds()
    const observer = new ResizeObserver(pushBounds)
    observer.observe(el)
    window.addEventListener('resize', pushBounds)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', pushBounds)
      void window.bearcode.browser.hide().catch(() => {
        /* the renderer is gone; there is no feedback surface left to update */
      })
    }
  }, [pushBounds])

  // A feedback revision earns permission to paint only when its own hide invoke
  // resolves. Rejection leaves the renderer blank: without hide confirmation,
  // native pixels could still cover an ErrorCard/Loading/EmptyState.
  useLayoutEffect(() => {
    const attempt = ++visibilityAttemptRef.current
    const revision = presentationRevision
    const isCurrent = (): boolean =>
      mountedRef.current &&
      attempt === visibilityAttemptRef.current &&
      revision === presentationRevisionRef.current
    const commandBlocked = pendingError !== null || commandError !== null
    const canShow = !commandBlocked && visible && status?.phase === 'ready' && status.connected

    if (!canShow) {
      void window.bearcode.browser.hide().then(
        () => {
          if (!isCurrent()) return
          setHideConfirmedRevision(revision)
          if (pendingError !== null) {
            setCommandError(pendingError)
            setPendingError(null)
          }
          if (!visible && hideRequest !== null) onHideSettled?.(hideRequest)
        },
        (error: unknown) => {
          if (!isCurrent()) return
          // Main rejects only after it has detached/closed the native view, so
          // this revision is safe to paint as an actionable command error.
          setHideConfirmedRevision(revision)
          setPendingError(null)
          setCommandError(errorMessage(error))
          // BrowserManager rejects only after its safety teardown completes,
          // so rejection confirms that native pixels can no longer overlap
          // the renderer just as a successful offscreen move does.
          if (!visible && hideRequest !== null) onHideSettled?.(hideRequest)
        }
      )
      return
    }

    const bounds = measuredBounds()
    if (!bounds) return
    void (async () => {
      try {
        await window.bearcode.browser.setBounds(bounds)
        if (!isCurrent()) return
        await window.bearcode.browser.show()
      } catch (error) {
        queueFailure(error, isCurrent)
      }
    })()
  }, [
    commandError,
    hideRequest,
    measuredBounds,
    onHideSettled,
    pendingError,
    presentationRevision,
    queueFailure,
    status,
    visible
  ])

  const mayPaintFeedback = hideConfirmedRevision === presentationRevision
  let feedback: React.ReactNode = null
  if (mayPaintFeedback) {
    if (commandError) {
      feedback = <ErrorCard>{commandError}</ErrorCard>
    } else if (status === null || status.phase === 'starting') {
      feedback = (
        <div role="status" aria-live="polite" aria-atomic="true">
          <Loading label="Preparing browser…" />
        </div>
      )
    } else if (status.phase === 'idle') {
      feedback = <EmptyState title="Browser is not active" />
    } else if (status.phase === 'error') {
      feedback = <ErrorCard>{status.message ?? 'The browser could not be started.'}</ErrorCard>
    }
  }

  return (
    <div className="browser-pane" ref={ref}>
      {feedback ? <div className="browser-pane-state">{feedback}</div> : null}
    </div>
  )
}
