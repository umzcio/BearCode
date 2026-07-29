import { useState } from 'react'
import { useAppStore } from '../state/store'
import { useAnimatedUnmount } from '../lib/useAnimatedUnmount'
import { prefersReducedMotion } from '../lib/prefersReducedMotion'
import { ArtifactsPaneContent } from './artifactsPane/ArtifactsPaneContent'
import './ArtifactsPane.css'

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
  // Keep rendering the last selection through the exit slide (mirrors how
  // Popover retains its children while closing). Overwritten on every open,
  // so a stale target can never leak into the next open.
  const [lastTarget, setLastTarget] = useState(target)
  if (target && target !== lastTarget) setLastTarget(target)

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

  const renderedTarget = target ?? lastTarget
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
        browserVisible={
          state === 'open' && motion.settled && renderedTarget.kind === 'browser' && open
        }
      />
    </div>
  )
}
