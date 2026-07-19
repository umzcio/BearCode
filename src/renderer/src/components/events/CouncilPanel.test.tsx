// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { CouncilPanel } from './CouncilPanel'
import type { Event } from '@shared/types'

afterEach(cleanup)

type CouncilSeatEvent = Extract<Event, { type: 'council_seat' }>

const seat = (
  id: string,
  name: string,
  stage: 'answer' | 'review',
  text: string,
  status: 'done' | 'failed' = 'done'
): CouncilSeatEvent => ({
  type: 'council_seat',
  id,
  seat: name,
  modelRef: `x/${name}`,
  stage,
  text,
  status
})

describe('CouncilPanel', () => {
  it('renders one collapsed labeled row per seat with the model name', () => {
    render(
      <CouncilPanel
        seats={[
          seat('a1', 'gpt-5.6-sol', 'answer', 'from gpt'),
          seat('a2', 'grok-4.5', 'answer', 'from grok')
        ]}
      />
    )
    expect(screen.getByText('gpt-5.6-sol')).toBeTruthy()
    expect(screen.getByText('grok-4.5')).toBeTruthy()
    // Collapsed by construction: no .step-row starts in the open state.
    expect(document.querySelectorAll('.council-seat.open').length).toBe(0)
  })

  it('groups answers and reviews under their own stage labels', () => {
    render(
      <CouncilPanel
        seats={[
          seat('a1', 'gpt-5.6-sol', 'answer', 'ans'),
          seat('r1', 'gpt-5.6-sol', 'review', 'rev')
        ]}
      />
    )
    expect(screen.getByText('Council · answers')).toBeTruthy()
    expect(screen.getByText('Peer review')).toBeTruthy()
    const stages = document.querySelectorAll('.council-stage')
    expect(stages.length).toBe(2)
    // The answer row lives under the answers stage, the review under peer review.
    expect(within(stages[0] as HTMLElement).getByText('seat')).toBeTruthy()
    expect(within(stages[1] as HTMLElement).getByText('review')).toBeTruthy()
  })

  it('expands a seat to reveal its markdown text on click', () => {
    render(<CouncilPanel seats={[seat('a1', 'grok-4.5', 'answer', 'the full answer')]} />)
    const row = document.querySelector('.council-seat') as HTMLElement
    expect(row.classList.contains('open')).toBe(false)
    fireEvent.click(row.querySelector('.step-row') as HTMLElement)
    expect(row.classList.contains('open')).toBe(true)
    expect(screen.getByText('the full answer')).toBeTruthy()
  })

  it('shows a static failed state that does not expand', () => {
    render(<CouncilPanel seats={[seat('a1', 'grok-4.5', 'answer', '', 'failed')]} />)
    const row = document.querySelector('.council-seat') as HTMLElement
    expect(row.classList.contains('failed')).toBe(true)
    expect(screen.getByText('failed')).toBeTruthy()
    // No expandable body for a failed seat, and clicking never opens it.
    fireEvent.click(row.querySelector('.step-row') as HTMLElement)
    expect(row.classList.contains('open')).toBe(false)
    expect(document.querySelector('.council-seat .step-body')).toBeNull()
  })

  it('renders nothing when there are no seats', () => {
    const { container } = render(<CouncilPanel seats={[]} />)
    expect(container.querySelector('.council')).toBeNull()
  })

  it('omits the peer-review stage when only answers exist', () => {
    render(<CouncilPanel seats={[seat('a1', 'gpt-5.6-sol', 'answer', 'ans')]} />)
    expect(screen.getByText('Council · answers')).toBeTruthy()
    expect(screen.queryByText('Peer review')).toBeNull()
  })
})
