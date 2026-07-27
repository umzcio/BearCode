// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResizeHandle } from './ResizeHandle'

describe('ResizeHandle', () => {
  let nextFrameId: number
  let frames: Map<number, FrameRequestCallback>

  beforeEach(() => {
    nextFrameId = 1
    frames = new Map()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        const id = nextFrameId++
        frames.set(id, callback)
        return id
      })
    )
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => {
        frames.delete(id)
      })
    )
  })

  afterEach(() => {
    cleanup()
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('emits the summed mousemove delta at most once per animation frame', () => {
    const onDrag = vi.fn()
    render(<ResizeHandle onDrag={onDrag} />)

    fireEvent.mouseDown(screen.getByRole('separator'), { clientX: 100 })
    fireEvent.mouseMove(window, { clientX: 104 })
    fireEvent.mouseMove(window, { clientX: 111 })
    fireEvent.mouseMove(window, { clientX: 109 })

    expect(onDrag).not.toHaveBeenCalled()
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1)

    frames.get(1)?.(16)

    expect(onDrag).toHaveBeenCalledTimes(1)
    expect(onDrag).toHaveBeenCalledWith(9)
  })

  it('flushes a pending delta synchronously before onDragEnd on mouseup', () => {
    const calls: string[] = []
    render(
      <ResizeHandle onDrag={(dx) => calls.push(`drag:${dx}`)} onDragEnd={() => calls.push('end')} />
    )

    fireEvent.mouseDown(screen.getByRole('separator'), { clientX: 40 })
    fireEvent.mouseMove(window, { clientX: 47 })
    fireEvent.mouseUp(window)

    expect(calls).toEqual(['drag:7', 'end'])
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1)
    expect(frames).toHaveLength(0)
  })

  it('restores document styles and removes active listeners on mouseup', () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    render(<ResizeHandle onDrag={vi.fn()} />)

    fireEvent.mouseDown(screen.getByRole('separator'), { clientX: 20 })
    const move = addSpy.mock.calls.find(([type]) => type === 'mousemove')?.[1]
    const up = addSpy.mock.calls.find(([type]) => type === 'mouseup')?.[1]

    expect(document.body.style.cursor).toBe('col-resize')
    expect(document.body.style.userSelect).toBe('none')

    fireEvent.mouseUp(window)

    expect(removeSpy).toHaveBeenCalledWith('mousemove', move)
    expect(removeSpy).toHaveBeenCalledWith('mouseup', up)
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
  })

  it('cancels pending work and cleans up an active drag on unmount', () => {
    const onDrag = vi.fn()
    const addSpy = vi.spyOn(window, 'addEventListener')
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const { unmount } = render(<ResizeHandle onDrag={onDrag} />)

    fireEvent.mouseDown(screen.getByRole('separator'), { clientX: 20 })
    fireEvent.mouseMove(window, { clientX: 25 })
    const move = addSpy.mock.calls.find(([type]) => type === 'mousemove')?.[1]
    const up = addSpy.mock.calls.find(([type]) => type === 'mouseup')?.[1]

    unmount()

    expect(cancelAnimationFrame).toHaveBeenCalledWith(1)
    expect(removeSpy).toHaveBeenCalledWith('mousemove', move)
    expect(removeSpy).toHaveBeenCalledWith('mouseup', up)
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
    expect(onDrag).not.toHaveBeenCalled()
  })

  it('cleans up a replaced drag so unmount abandons both drags', () => {
    const onDrag = vi.fn()
    const addSpy = vi.spyOn(window, 'addEventListener')
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const { unmount } = render(<ResizeHandle onDrag={onDrag} />)
    const handle = screen.getByRole('separator')

    fireEvent.mouseDown(handle, { clientX: 20 })
    fireEvent.mouseMove(window, { clientX: 25 })
    fireEvent.mouseDown(handle, { clientX: 100 })
    fireEvent.mouseMove(window, { clientX: 105 })

    const moves = addSpy.mock.calls
      .filter(([type]) => type === 'mousemove')
      .map(([, listener]) => listener)
    const ups = addSpy.mock.calls
      .filter(([type]) => type === 'mouseup')
      .map(([, listener]) => listener)

    unmount()
    fireEvent.mouseMove(window, { clientX: 110 })
    for (const [id, callback] of frames) {
      frames.delete(id)
      callback(16)
    }

    expect(moves).toHaveLength(2)
    expect(ups).toHaveLength(2)
    for (const move of moves) expect(removeSpy).toHaveBeenCalledWith('mousemove', move)
    for (const up of ups) expect(removeSpy).toHaveBeenCalledWith('mouseup', up)
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1)
    expect(cancelAnimationFrame).toHaveBeenCalledWith(2)
    expect(onDrag).not.toHaveBeenCalled()
  })
})
