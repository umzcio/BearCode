// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useAppStore } from '../../state/store'
import { EffortPicker } from './EffortPicker'

beforeEach(() => {
  useAppStore.setState({
    view: { kind: 'home' },
    effort: 'adaptive',
    thinking: true,
    modelRef: 'anthropic/claude-opus-4-8'
  })
})
afterEach(cleanup)

describe('EffortPicker', () => {
  it('shows the current effort label on the pill', () => {
    render(<EffortPicker />)
    expect(screen.getByText('Adaptive')).toBeTruthy()
  })
  it('lists the six effort options and the Thinking row', () => {
    render(<EffortPicker />)
    fireEvent.click(screen.getByText('Adaptive'))
    for (const label of ['Low', 'Medium', 'High', 'Extra', 'Max']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
    expect(screen.getByText('Thinking')).toBeTruthy()
  })
  it('picking a tier updates the store', () => {
    render(<EffortPicker />)
    fireEvent.click(screen.getByText('Adaptive'))
    fireEvent.click(screen.getByText('High'))
    expect(useAppStore.getState().effort).toBe('high')
  })
  it('toggling Thinking updates the store', () => {
    render(<EffortPicker />)
    fireEvent.click(screen.getByText('Adaptive'))
    fireEvent.click(screen.getByText('Thinking'))
    expect(useAppStore.getState().thinking).toBe(false)
  })
  it('greys the effort section for a non-Anthropic model', () => {
    useAppStore.setState({ modelRef: 'openai/gpt-5' })
    render(<EffortPicker />)
    fireEvent.click(screen.getByText('Adaptive'))
    // Clicking a greyed tier is a no-op.
    fireEvent.click(screen.getByText('High'))
    expect(useAppStore.getState().effort).toBe('adaptive')
  })
})
