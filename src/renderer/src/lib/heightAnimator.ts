import { evaluateCubicBezier, type CubicBezier } from './motionTokens'

export interface HeightAnimator {
  retarget: (height: number, onComplete?: () => void) => void
  cancel: () => void
  current: () => number
}

interface HeightAnimatorOptions {
  initialHeight: number
  durationMs: number | null
  curve: CubicBezier | null
  reduced: boolean | (() => boolean)
  apply: (height: number) => void
  now?: () => number
  requestFrame?: (callback: FrameRequestCallback) => number
  cancelFrame?: (id: number) => void
}

export function createHeightAnimator({
  initialHeight,
  durationMs,
  curve,
  reduced,
  apply,
  now = () => performance.now(),
  requestFrame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (id) => cancelAnimationFrame(id)
}: HeightAnimatorOptions): HeightAnimator {
  let height = Math.max(0, initialHeight)
  let frameId: number | null = null
  let activeTarget: number | null = null
  let generation = 0

  const isReduced = (): boolean => (typeof reduced === 'function' ? reduced() : reduced)

  const cancel = (): void => {
    generation += 1
    if (frameId !== null) cancelFrame(frameId)
    frameId = null
    activeTarget = null
  }

  const retarget = (nextHeight: number, onComplete?: () => void): void => {
    const target = Math.max(0, Number.isFinite(nextHeight) ? nextHeight : 0)
    const shouldReduce = isReduced()
    if (frameId !== null && activeTarget === target) return

    cancel()
    if (
      shouldReduce ||
      durationMs === null ||
      durationMs <= 0 ||
      curve === null ||
      target === height
    ) {
      height = target
      apply(height)
      onComplete?.()
      return
    }

    const run = generation
    const from = height
    const startedAt = now()
    activeTarget = target
    const tick = (): void => {
      if (run !== generation) return
      frameId = null
      if (isReduced()) {
        height = target
        activeTarget = null
        apply(height)
        if (run === generation) onComplete?.()
        return
      }
      const progress = Math.min(1, Math.max(0, (now() - startedAt) / durationMs))
      height = from + (target - from) * evaluateCubicBezier(curve, progress)
      apply(height)
      if (run !== generation) return
      if (progress < 1) {
        frameId = requestFrame(tick)
      } else {
        activeTarget = null
        onComplete?.()
      }
    }
    frameId = requestFrame(tick)
  }

  return {
    retarget,
    cancel,
    current: () => height
  }
}
