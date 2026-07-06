// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { useAppStore } from '../../state/store'
import { ContextMeter } from './ContextMeter'

const providers = [
  { id: 'anthropic', displayName: 'A', color: '#000', requiresKey: true, keyConfigured: true, reachable: true, models: [{ id: 'm', label: 'M', contextWindow: 100 }] }
] as unknown as never

beforeEach(() => {
  useAppStore.setState({ providers, modelRef: 'anthropic/m' })
})
afterEach(cleanup)

const convo = (events: unknown[]): Record<string, unknown> => ({
  id: 'c1', projectPath: null, projectLabel: 'r', title: 'T', modelRef: 'anthropic/m',
  permissionMode: 'accept-edits', effort: 'adaptive', thinking: true, projectId: null,
  updatedAt: 1, createdAt: 1, loaded: true, events, runState: 'idle'
})

describe('ContextMeter', () => {
  it('hidden with no active conversation', () => {
    useAppStore.setState({ view: { kind: 'home' } })
    const { container } = render(<ContextMeter />)
    expect(container.firstChild).toBeNull()
  })
  it('hidden when the model has no known window', () => {
    useAppStore.setState({
      modelRef: 'ollama/x',
      view: { kind: 'conversation', id: 'c1' },
      conversations: { c1: convo([{ type: 'user_message', id: 'u', text: 'x'.repeat(40) }]) as never }
    })
    const { container } = render(<ContextMeter />)
    expect(container.firstChild).toBeNull()
  })
  it('shows a percentage for an active conversation', () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      conversations: { c1: convo([{ type: 'user_message', id: 'u', text: 'x'.repeat(200) }]) as never }
    })
    render(<ContextMeter />)
    // 200 chars ≈ 50 tokens / 100 window = 50%
    expect(screen.getByText(/50% context/i)).toBeTruthy()
  })
  it('adds the near-limit class past 80%', () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      conversations: { c1: convo([{ type: 'user_message', id: 'u', text: 'x'.repeat(360) }]) as never }
    })
    const { container } = render(<ContextMeter />)
    expect(container.querySelector('.context-meter.near')).toBeTruthy()
  })
})
