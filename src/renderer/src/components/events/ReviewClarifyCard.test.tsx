// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ReviewClarifyCard } from './ReviewClarifyCard'
import type { Event } from '@shared/types'

const resolveClarify = vi.fn(() => Promise.resolve())
const cancel = vi.fn(() => Promise.resolve())
beforeEach(() => {
  resolveClarify.mockClear()
  cancel.mockClear()
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.bearcode = {
    review: { resolveClarify },
    run: { cancel }
  }
})
afterEach(cleanup)

function clarifyEvent(overrides: Partial<Event>): Event {
  return {
    type: 'review_clarify',
    id: 'cl1',
    askLens: false,
    askScope: false,
    createdAt: 1,
    ...overrides
  } as unknown as Event
}

describe('ReviewClarifyCard', () => {
  it('askLens only: shows the 5 lens chips and no scope input; picking a chip resolves immediately', () => {
    const event = clarifyEvent({ askLens: true, askScope: false, scope: 'src/ui' })
    render(<ReviewClarifyCard event={event as never} convoId="c1" />)

    for (const label of ['Code', 'Security', 'Accessibility', 'Performance', 'Comprehensive']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    expect(screen.queryByLabelText('Scope')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()

    fireEvent.click(screen.getByText('Security'))
    expect(resolveClarify).toHaveBeenCalledWith('c1', 'security', 'src/ui')
  })

  it('askScope only: shows a scope input and no lens chips; Confirm resolves with event.lens', () => {
    const event = clarifyEvent({ askLens: false, askScope: true, lens: 'code' })
    render(<ReviewClarifyCard event={event as never} convoId="c1" />)

    expect(screen.queryByText('Security')).toBeNull()
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'src/renderer' } })
    fireEvent.click(screen.getByText('Confirm'))
    expect(resolveClarify).toHaveBeenCalledWith('c1', 'code', 'src/renderer')
  })

  it('askScope only: Confirm is disabled while the scope field is empty', () => {
    const event = clarifyEvent({ askLens: false, askScope: true, lens: 'code' })
    render(<ReviewClarifyCard event={event as never} convoId="c1" />)
    const confirmBtn = screen.getByText('Confirm') as HTMLButtonElement
    expect(confirmBtn.disabled).toBe(true)
    fireEvent.click(confirmBtn)
    expect(resolveClarify).not.toHaveBeenCalled()
  })

  it('both askLens and askScope: a chip pick alone does not resolve, only Confirm does', () => {
    const event = clarifyEvent({ askLens: true, askScope: true })
    render(<ReviewClarifyCard event={event as never} convoId="c1" />)

    fireEvent.click(screen.getByText('Performance'))
    expect(resolveClarify).not.toHaveBeenCalled()

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'src' } })
    fireEvent.click(screen.getByText('Confirm'))
    expect(resolveClarify).toHaveBeenCalledWith('c1', 'performance', 'src')
  })

  it('IMPORTANT 3: a second Confirm click after the first does not double-dispatch', () => {
    const event = clarifyEvent({ askLens: false, askScope: true, lens: 'code' })
    render(<ReviewClarifyCard event={event as never} convoId="c1" />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'src/renderer' } })
    const confirmBtn = screen.getByText('Confirm') as HTMLButtonElement

    fireEvent.click(confirmBtn)
    expect(resolveClarify).toHaveBeenCalledTimes(1)
    // Confirm is now disabled -- a second click (or an impatient double-click
    // before React re-renders in a real browser) must not fire a second run.
    expect(confirmBtn.disabled).toBe(true)
    fireEvent.click(confirmBtn)
    expect(resolveClarify).toHaveBeenCalledTimes(1)
    // The scope input and chips are locked too -- nothing left to interact with.
    expect((input as HTMLInputElement).disabled).toBe(true)
  })

  it('IMPORTANT 3: a second chip click after the first (lens-only card) does not double-dispatch', () => {
    const event = clarifyEvent({ askLens: true, askScope: false, scope: 'src/ui' })
    render(<ReviewClarifyCard event={event as never} convoId="c1" />)

    fireEvent.click(screen.getByText('Security'))
    expect(resolveClarify).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('Security'))
    fireEvent.click(screen.getByText('Code'))
    expect(resolveClarify).toHaveBeenCalledTimes(1)
  })

  it('IMPORTANT 2: Cancel calls the shared cancelRun action (same path as the composer Stop button)', () => {
    const event = clarifyEvent({ askLens: true, askScope: true })
    render(<ReviewClarifyCard event={event as never} convoId="c1" />)

    fireEvent.click(screen.getByText('Cancel'))
    expect(cancel).toHaveBeenCalledWith('c1')
    expect(resolveClarify).not.toHaveBeenCalled()
  })
})
