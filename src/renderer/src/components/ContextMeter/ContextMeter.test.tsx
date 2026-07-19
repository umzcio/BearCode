// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { useAppStore } from '../../state/store'
import { ContextMeter } from './ContextMeter'

const providers = [
  {
    id: 'anthropic',
    displayName: 'A',
    color: '#000',
    requiresKey: true,
    keyConfigured: true,
    reachable: true,
    models: [
      { id: 'm', label: 'M', contextWindow: 100 },
      { id: 'claude-opus-4-8', label: 'Opus 4.8', contextWindow: 200000 },
      { id: 'claude-sonnet-5', label: 'Sonnet 5', contextWindow: 200000 }
    ]
  }
] as unknown as never

beforeEach(() => {
  useAppStore.setState({ providers, modelRef: 'anthropic/m' })
})
afterEach(cleanup)

const convo = (events: unknown[]): Record<string, unknown> => ({
  id: 'c1',
  projectPath: null,
  projectLabel: 'r',
  title: 'T',
  modelRef: 'anthropic/m',
  permissionMode: 'accept-edits',
  effort: 'adaptive',
  thinking: true,
  projectId: null,
  updatedAt: 1,
  createdAt: 1,
  loaded: true,
  events,
  runState: 'idle'
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
      conversations: {
        c1: convo([{ type: 'user_message', id: 'u', text: 'x'.repeat(40) }]) as never
      }
    })
    const { container } = render(<ContextMeter />)
    expect(container.firstChild).toBeNull()
  })
  it('shows a percentage for an active conversation', () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      conversations: {
        c1: convo([{ type: 'user_message', id: 'u', text: 'x'.repeat(200) }]) as never
      }
    })
    render(<ContextMeter />)
    // 200 chars ≈ 50 tokens / 100 window = 50%; the ring exposes it via aria-label
    expect(screen.getByLabelText(/50% used/i)).toBeTruthy()
  })
  it('adds the near-limit class past 80%', () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      conversations: {
        c1: convo([{ type: 'user_message', id: 'u', text: 'x'.repeat(360) }]) as never
      }
    })
    const { container } = render(<ContextMeter />)
    expect(container.querySelector('.context-ring.near')).toBeTruthy()
  })

  it('shows the per-model breakdown and total cost when turn_meta usage exists', () => {
    useAppStore.setState({
      settings: null,
      view: { kind: 'conversation', id: 'c1' },
      conversations: {
        c1: convo([
          {
            type: 'turn_meta',
            id: 't1',
            provider: 'anthropic',
            model: 'claude-opus-4-8',
            startedAt: 1,
            endedAt: 2,
            usage: { inputTokens: 18200, outputTokens: 3100, lastInputTokens: 18200 }
          },
          {
            type: 'turn_meta',
            id: 't2',
            provider: 'anthropic',
            model: 'claude-sonnet-5',
            startedAt: 3,
            endedAt: 4,
            usage: { inputTokens: 4000, outputTokens: 800, lastInputTokens: 4000 }
          }
        ]) as never
      }
    })
    render(<ContextMeter />)
    fireEvent.click(screen.getByLabelText(/context/i))
    // "By model" list names both models
    expect(screen.getByText(/by model/i)).toBeTruthy()
    expect(screen.getByText('Opus 4.8')).toBeTruthy()
    expect(screen.getByText('Sonnet 5')).toBeTruthy()
    // per-model + total cost (opus $0.17 + sonnet $0.02 = $0.19)
    expect(screen.getByText('$0.17')).toBeTruthy()
    expect(screen.getByText('$0.02')).toBeTruthy()
    expect(screen.getByText(/total cost/i)).toBeTruthy()
    expect(screen.getByText('$0.19')).toBeTruthy()
    // measured, not estimated
    expect(screen.queryByText(/estimated/i)).toBeNull()
    expect(screen.getByText(/measured/i)).toBeTruthy()
  })

  it('shows a "By role" breakdown when turns carry an ursaRole', () => {
    useAppStore.setState({
      settings: null,
      view: { kind: 'conversation', id: 'c1' },
      conversations: {
        c1: convo([
          {
            type: 'turn_meta',
            id: 't1',
            provider: 'anthropic',
            model: 'claude-opus-4-8',
            startedAt: 1,
            endedAt: 2,
            usage: { inputTokens: 18200, outputTokens: 3100, lastInputTokens: 18200 },
            ursaRole: 'coder'
          },
          {
            type: 'turn_meta',
            id: 't2',
            provider: 'anthropic',
            model: 'claude-sonnet-5',
            startedAt: 3,
            endedAt: 4,
            usage: { inputTokens: 4000, outputTokens: 800, lastInputTokens: 4000 },
            ursaRole: 'writer'
          }
        ]) as never
      }
    })
    render(<ContextMeter />)
    fireEvent.click(screen.getByLabelText(/context/i))
    expect(screen.getByText(/by role/i)).toBeTruthy()
    expect(screen.getByText('coder')).toBeTruthy()
    expect(screen.getByText('writer')).toBeTruthy()
  })

  it('hides the "By role" section when no turn carries an ursaRole', () => {
    useAppStore.setState({
      settings: null,
      view: { kind: 'conversation', id: 'c1' },
      conversations: {
        c1: convo([
          {
            type: 'turn_meta',
            id: 't1',
            provider: 'anthropic',
            model: 'claude-opus-4-8',
            startedAt: 1,
            endedAt: 2,
            usage: { inputTokens: 18200, outputTokens: 3100, lastInputTokens: 18200 }
          }
        ]) as never
      }
    })
    render(<ContextMeter />)
    fireEvent.click(screen.getByLabelText(/context/i))
    // By-model breakdown is present, but the role section is not.
    expect(screen.getByText(/by model/i)).toBeTruthy()
    expect(screen.queryByText(/by role/i)).toBeNull()
  })

  it('shows only the estimated ring line when no usage exists', () => {
    useAppStore.setState({
      settings: null,
      view: { kind: 'conversation', id: 'c1' },
      conversations: {
        c1: convo([{ type: 'user_message', id: 'u', text: 'x'.repeat(200) }]) as never
      }
    })
    render(<ContextMeter />)
    fireEvent.click(screen.getByLabelText(/context/i))
    expect(screen.queryByText(/by model/i)).toBeNull()
    expect(screen.queryByText(/total cost/i)).toBeNull()
    expect(screen.getByText(/estimated/i)).toBeTruthy()
  })
})
