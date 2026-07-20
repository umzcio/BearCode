// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
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
  it('greys the effort section for a non-reasoning OpenAI model', () => {
    // gpt-5-chat is explicitly excluded from OpenAI's reasoning-model family
    // (unlike gpt-5/gpt-5.6-*, which are now effort-enabled -- see effort.ts).
    useAppStore.setState({ modelRef: 'openai/gpt-5-chat' })
    render(<EffortPicker />)
    fireEvent.click(screen.getByText('Adaptive'))
    // Clicking a greyed tier is a no-op.
    fireEvent.click(screen.getByText('High'))
    expect(useAppStore.getState().effort).toBe('adaptive')
  })
  it('enables effort (but not thinking) for an OpenAI reasoning model', () => {
    useAppStore.setState({ modelRef: 'openai/gpt-5.6-sol' })
    render(<EffortPicker />)
    fireEvent.click(screen.getByText('Adaptive'))
    fireEvent.click(screen.getByText('High'))
    expect(useAppStore.getState().effort).toBe('high')
    expect(screen.queryByText('Thinking')).toBeNull()
  })
  it('closes when Settings opens', () => {
    render(<EffortPicker />)
    fireEvent.click(screen.getByText('Adaptive'))
    expect(screen.getByText('High')).toBeTruthy()
    // useAppStore.setState alone doesn't synchronously flush the resulting
    // re-render under React 19 + RTL's automatic batching outside act() --
    // wrap it so the assertion below observes the post-close DOM.
    act(() => {
      useAppStore.setState({ settingsOpen: true })
    })
    expect(screen.queryByText('High')).toBeNull()
  })
})
