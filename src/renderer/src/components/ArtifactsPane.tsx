import { useCallback, useState } from 'react'
import { useAppStore, type AuxSelection } from '../state/store'
import { useAnimatedUnmount } from '../lib/useAnimatedUnmount'
import { prefersReducedMotion } from '../lib/prefersReducedMotion'
import { ArtifactsPaneContent } from './artifactsPane/ArtifactsPaneContent'
import './ArtifactsPane.css'

interface PanePresentation {
  requested: AuxSelection | null
  displayed: AuxSelection | null
  browserHideRequest: number | null
  nextBrowserHideRequest: number
  browserHidden: boolean
}

function presentationForTarget(
  presentation: PanePresentation,
  target: AuxSelection | null
): PanePresentation {
  if (target === presentation.requested) return presentation

  if (presentation.displayed?.kind === 'browser') {
    if (target?.kind === 'browser') {
      return {
        ...presentation,
        requested: target,
        displayed: target,
        browserHidden: presentation.browserHideRequest === null ? false : presentation.browserHidden
      }
    }
    if (presentation.browserHideRequest !== null) {
      return { ...presentation, requested: target }
    }
    if (presentation.browserHidden) {
      return target
        ? {
            ...presentation,
            requested: target,
            displayed: target,
            browserHidden: false
          }
        : { ...presentation, requested: null }
    }
    return {
      ...presentation,
      requested: target,
      browserHideRequest: presentation.nextBrowserHideRequest,
      nextBrowserHideRequest: presentation.nextBrowserHideRequest + 1
    }
  }

  return {
    ...presentation,
    requested: target,
    displayed: target ?? presentation.displayed,
    browserHidden: false
  }
}

// The Artifacts pane (Ba4, design 3.6), reskinned 2026-07-06 with the two-row
// Artifact Panel header. ONE side panel listing every deliverable of the
// current conversation -- plan/walkthrough artifacts plus one virtual "Changes"
// entry per diff group. The store's auxSelection deep-links a target; rail
// browsing is local state, overridden by the next deep-link via auxPaneOpenTick.
export function ArtifactsPane(): React.JSX.Element | null {
  const target = useAppStore((s) => s.auxSelection)
  const auxPaneWidth = useAppStore((s) => s.auxPaneWidth)
  const open = Boolean(target)
  const { mounted, state, completeExit } = useAnimatedUnmount(open, {
    exitCompletion: 'signal'
  })
  // Browser pixels live in a main-process WebContentsView, so a browser ->
  // renderer-content transition must not commit until BrowserPane confirms its
  // current authoritative hide. Other target changes remain synchronous.
  const [presentation, setPresentation] = useState<PanePresentation>(() => ({
    requested: target,
    displayed: target,
    browserHideRequest: null,
    nextBrowserHideRequest: 1,
    browserHidden: false
  }))
  const nextPresentation = presentationForTarget(presentation, target)
  if (nextPresentation !== presentation) setPresentation(nextPresentation)

  const completeBrowserHide = useCallback((request: number): void => {
    setPresentation((current) => {
      if (current.browserHideRequest !== request) return current
      if (current.requested && current.requested.kind !== 'browser') {
        return {
          ...current,
          displayed: current.requested,
          browserHideRequest: null,
          browserHidden: false
        }
      }
      return {
        ...current,
        browserHideRequest: null,
        // A closed shell can reuse this confirmation if it reopens directly
        // onto renderer content before the browser is shown again.
        browserHidden: current.requested === null
      }
    })
  }, [])

  // Renderer transforms cannot move the main-process WebContentsView. Track
  // whether the shell itself has finished opening so native pixels stay
  // offscreen until their final bounds are stable.
  const [motion, setMotion] = useState(() => ({
    open,
    settled: open && prefersReducedMotion()
  }))
  if (motion.open !== open) {
    setMotion({ open, settled: open && prefersReducedMotion() })
  }

  const renderedTarget = nextPresentation.displayed
  if (!mounted || !renderedTarget) return null
  const onTransitionEnd = (event: React.TransitionEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget || event.propertyName !== 'transform') return
    if (state === 'closing') {
      completeExit()
    } else {
      setMotion({ open: true, settled: true })
    }
  }

  return (
    <div
      className={'ap-panel' + (renderedTarget.kind === 'attachment' ? ' ap-attachment-panel' : '')}
      data-state={state}
      data-panel-kind={renderedTarget.kind}
      style={{ flexBasis: auxPaneWidth }}
      onTransitionEnd={onTransitionEnd}
    >
      <ArtifactsPaneContent
        target={renderedTarget}
        browserHideRequest={nextPresentation.browserHideRequest}
        onBrowserHideSettled={completeBrowserHide}
        browserVisible={
          state === 'open' &&
          motion.settled &&
          renderedTarget.kind === 'browser' &&
          target?.kind === 'browser' &&
          nextPresentation.browserHideRequest === null
        }
      />
    </div>
  )
}
