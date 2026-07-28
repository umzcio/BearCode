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
  reduced: boolean
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
  let generation = 0

  const cancel = (): void => {
    generation += 1
    if (frameId !== null) cancelFrame(frameId)
    frameId = null
  }

  const retarget = (nextHeight: number, onComplete?: () => void): void => {
    cancel()
    const target = Math.max(0, Number.isFinite(nextHeight) ? nextHeight : 0)
    if (reduced || durationMs === null || durationMs <= 0 || curve === null || target === height) {
      height = target
      apply(height)
      onComplete?.()
      return
    }

    const run = generation
    const from = height
    const startedAt = now()
    const tick = (): void => {
      if (run !== generation) return
      const progress = Math.min(1, Math.max(0, (now() - startedAt) / durationMs))
      height = from + (target - from) * evaluateCubicBezier(curve, progress)
      apply(height)
      if (progress < 1) {
        frameId = requestFrame(tick)
      } else {
        frameId = null
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
