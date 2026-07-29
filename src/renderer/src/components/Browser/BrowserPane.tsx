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
export function BrowserPane({ visible }: { visible: boolean }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const mountedRef = useRef(true)
  const statusRevisionRef = useRef(0)
  const visibilityAttemptRef = useRef(0)
  const boundsAttemptRef = useRef(0)
  const [status, setStatus] = useState<BrowserStatus | null>(null)
  const [commandError, setCommandError] = useState<string | null>(null)

  const surfaceFailure = useCallback(
    (error: unknown, isCurrent: () => boolean, hideFirst = true): void => {
      if (!mountedRef.current || !isCurrent()) return
      const message = errorMessage(error)
      if (hideFirst) {
        const hide = window.bearcode.browser.hide()
        void hide.catch((hideError: unknown) => {
          if (mountedRef.current && isCurrent()) setCommandError(errorMessage(hideError))
        })
      }
      setCommandError(message)
    },
    []
  )

  const measuredBounds = useCallback(() => {
    const rect = ref.current?.getBoundingClientRect()
    return rect
      ? {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      : null
  }, [])

  const pushBounds = useCallback((): void => {
    const bounds = measuredBounds()
    if (!bounds) return
    const attempt = ++boundsAttemptRef.current
    const revision = statusRevisionRef.current
    void window.bearcode.browser.setBounds(bounds).catch((error: unknown) => {
      surfaceFailure(
        error,
        () => attempt === boundsAttemptRef.current && revision === statusRevisionRef.current,
        true
      )
    })
  }, [measuredBounds, surfaceFailure])

  // Subscribe before invoking status(). A pushed status increments the revision,
  // making any later initial result/rejection stale and therefore harmless.
  useEffect(() => {
    mountedRef.current = true
    const applyStatus = (next: BrowserStatus): void => {
      statusRevisionRef.current += 1
      visibilityAttemptRef.current += 1
      setCommandError(null)
      setStatus(next)
    }
    const initialRevision = statusRevisionRef.current
    const unsubscribe = window.bearcode.browser.onStatus(applyStatus)
    void window.bearcode.browser.status().then(
      (initial) => {
        if (mountedRef.current && statusRevisionRef.current === initialRevision) {
          applyStatus(initial)
        }
      },
      (error: unknown) => {
        surfaceFailure(error, () => statusRevisionRef.current === initialRevision, true)
      }
    )
    return () => {
      mountedRef.current = false
      statusRevisionRef.current += 1
      visibilityAttemptRef.current += 1
      boundsAttemptRef.current += 1
      unsubscribe()
    }
  }, [surfaceFailure])

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

  // Layout timing ensures hide/show is requested before React yields a painted
  // lifecycle surface. Ready is the only branch allowed to progress to show,
  // and setBounds must resolve first so native pixels never use stale geometry.
  useLayoutEffect(() => {
    const attempt = ++visibilityAttemptRef.current
    const revision = statusRevisionRef.current
    const isCurrent = (): boolean =>
      attempt === visibilityAttemptRef.current && revision === statusRevisionRef.current
    const canShow = visible && status?.phase === 'ready' && status.connected

    if (!canShow) {
      void window.bearcode.browser.hide().catch((error: unknown) => {
        surfaceFailure(error, isCurrent, false)
      })
      return
    }

    const bounds = measuredBounds()
    if (!bounds) return
    void (async () => {
      try {
        await window.bearcode.browser.setBounds(bounds)
        if (!mountedRef.current || !isCurrent()) return
        await window.bearcode.browser.show()
      } catch (error) {
        surfaceFailure(error, isCurrent, true)
      }
    })()
  }, [measuredBounds, status, surfaceFailure, visible])

  let feedback: React.ReactNode = null
  if (commandError) {
    feedback = <ErrorCard>{commandError}</ErrorCard>
  } else if (status === null || status.phase === 'starting') {
    feedback = <Loading label="Preparing browser…" />
  } else if (status.phase === 'idle') {
    feedback = <EmptyState title="Browser is not active" />
  } else if (status.phase === 'error') {
    feedback = <ErrorCard>{status.message ?? 'The browser could not be started.'}</ErrorCard>
  }

  return (
    <div className="browser-pane" ref={ref}>
      {feedback ? <div className="browser-pane-state">{feedback}</div> : null}
    </div>
  )
}
