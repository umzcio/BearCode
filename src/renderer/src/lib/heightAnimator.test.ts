import { describe, expect, it, vi } from 'vitest'
import { createHeightAnimator } from './heightAnimator'

function frameHarness(): {
  now: () => number
  requestFrame: (callback: FrameRequestCallback) => number
  cancelFrame: (id: number) => void
  flushAt: (time: number) => void
  pending: () => number
  requested: () => number
  canceled: () => number
} {
  let time = 0
  let nextId = 1
  let requestCount = 0
  let cancelCount = 0
  const frames = new Map<number, FrameRequestCallback>()
  return {
    now: () => time,
    requestFrame: (callback) => {
      requestCount += 1
      const id = nextId++
      frames.set(id, callback)
      return id
    },
    cancelFrame: (id) => {
      cancelCount += 1
      frames.delete(id)
    },
    flushAt: (nextTime) => {
      time = nextTime
      const queued = [...frames.values()]
      frames.clear()
      for (const callback of queued) callback(time)
    },
    pending: () => frames.size,
    requested: () => requestCount,
    canceled: () => cancelCount
  }
}

describe('createHeightAnimator', () => {
  it('animates to a target and completes the latest run', () => {
    const frames = frameHarness()
    const apply = vi.fn()
    const completed = vi.fn()
    const animator = createHeightAnimator({
      initialHeight: 0,
      durationMs: 100,
      curve: [0, 0, 1, 1],
      reduced: false,
      apply,
      ...frames
    })

    animator.retarget(100, completed)
    frames.flushAt(50)
    expect(animator.current()).toBeCloseTo(50, 4)
    frames.flushAt(100)

    expect(apply).toHaveBeenLastCalledWith(100)
    expect(completed).toHaveBeenCalledTimes(1)
    expect(frames.pending()).toBe(0)
  })

  it('retargets from the current height when interrupted', () => {
    const frames = frameHarness()
    const apply = vi.fn()
    const staleCompletion = vi.fn()
    const closeCompletion = vi.fn()
    const animator = createHeightAnimator({
      initialHeight: 0,
      durationMs: 100,
      curve: [0, 0, 1, 1],
      reduced: false,
      apply,
      ...frames
    })

    animator.retarget(100, staleCompletion)
    frames.flushAt(50)
    animator.retarget(0, closeCompletion)
    expect(animator.current()).toBeCloseTo(50, 4)

    frames.flushAt(100)
    expect(animator.current()).toBeCloseTo(25, 4)
    frames.flushAt(150)

    expect(animator.current()).toBe(0)
    expect(staleCompletion).not.toHaveBeenCalled()
    expect(closeCompletion).toHaveBeenCalledTimes(1)
  })

  it('keeps an active identical target on its original run and completion', () => {
    const frames = frameHarness()
    const apply = vi.fn()
    const originalCompletion = vi.fn()
    const duplicateCompletion = vi.fn()
    const animator = createHeightAnimator({
      initialHeight: 0,
      durationMs: 100,
      curve: [0, 0, 1, 1],
      reduced: false,
      apply,
      ...frames
    })

    animator.retarget(100, originalCompletion)
    animator.retarget(100, duplicateCompletion)

    expect(frames.pending()).toBe(1)
    expect(frames.requested()).toBe(1)
    expect(frames.canceled()).toBe(0)

    frames.flushAt(50)
    expect(animator.current()).toBeCloseTo(50, 4)
    frames.flushAt(100)

    expect(animator.current()).toBe(100)
    expect(originalCompletion).toHaveBeenCalledTimes(1)
    expect(duplicateCompletion).not.toHaveBeenCalled()
    expect(frames.pending()).toBe(0)
  })

  it('reads reduced motion during an active run and snaps on the next frame', () => {
    const frames = frameHarness()
    const apply = vi.fn()
    const completed = vi.fn()
    let reduced = false
    const animator = createHeightAnimator({
      initialHeight: 0,
      durationMs: 100,
      curve: [0, 0, 1, 1],
      reduced: () => reduced,
      apply,
      ...frames
    })

    animator.retarget(100, completed)
    frames.flushAt(40)
    expect(animator.current()).toBeCloseTo(40, 4)

    reduced = true
    frames.flushAt(60)

    expect(animator.current()).toBe(100)
    expect(apply).toHaveBeenLastCalledWith(100)
    expect(completed).toHaveBeenCalledTimes(1)
    expect(frames.pending()).toBe(0)
    frames.flushAt(100)
    expect(completed).toHaveBeenCalledTimes(1)
  })

  it('allows the completed height to become a new synchronous target', () => {
    const frames = frameHarness()
    const firstCompletion = vi.fn()
    const secondCompletion = vi.fn()
    const animator = createHeightAnimator({
      initialHeight: 0,
      durationMs: 100,
      curve: [0, 0, 1, 1],
      reduced: false,
      apply: vi.fn(),
      ...frames
    })

    animator.retarget(100, firstCompletion)
    frames.flushAt(100)
    animator.retarget(100, secondCompletion)

    expect(firstCompletion).toHaveBeenCalledTimes(1)
    expect(secondCompletion).toHaveBeenCalledTimes(1)
    expect(frames.requested()).toBe(1)
    expect(frames.pending()).toBe(0)
  })

  it('snaps a closing run when reduced motion becomes active', () => {
    const frames = frameHarness()
    const completed = vi.fn()
    let reduced = false
    const animator = createHeightAnimator({
      initialHeight: 100,
      durationMs: 100,
      curve: [0, 0, 1, 1],
      reduced: () => reduced,
      apply: vi.fn(),
      ...frames
    })

    animator.retarget(0, completed)
    frames.flushAt(50)
    expect(animator.current()).toBeCloseTo(50, 4)

    reduced = true
    frames.flushAt(75)

    expect(animator.current()).toBe(0)
    expect(completed).toHaveBeenCalledTimes(1)
    expect(frames.pending()).toBe(0)
  })

  it.each([
    { label: 'reduced motion', durationMs: 100, curve: [0, 0, 1, 1] as const, reduced: true },
    { label: 'missing duration', durationMs: null, curve: [0, 0, 1, 1] as const, reduced: false },
    { label: 'missing curve', durationMs: 100, curve: null, reduced: false }
  ])('snaps synchronously for $label', ({ durationMs, curve, reduced }) => {
    const frames = frameHarness()
    const apply = vi.fn()
    const completed = vi.fn()
    const animator = createHeightAnimator({
      initialHeight: 4,
      durationMs,
      curve,
      reduced,
      apply,
      ...frames
    })

    animator.retarget(72, completed)

    expect(animator.current()).toBe(72)
    expect(apply).toHaveBeenLastCalledWith(72)
    expect(completed).toHaveBeenCalledTimes(1)
    expect(frames.pending()).toBe(0)
  })

  it('cancels queued work and completion', () => {
    const frames = frameHarness()
    const apply = vi.fn()
    const completed = vi.fn()
    const animator = createHeightAnimator({
      initialHeight: 0,
      durationMs: 100,
      curve: [0, 0, 1, 1],
      reduced: false,
      apply,
      ...frames
    })

    animator.retarget(100, completed)
    animator.cancel()
    expect(frames.pending()).toBe(0)
    frames.flushAt(100)

    expect(apply).not.toHaveBeenCalled()
    expect(completed).not.toHaveBeenCalled()
  })
})
