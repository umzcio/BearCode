// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { Composer } from './Composer'
import { useAppStore } from '../../state/store'
import { URSA_MODEL_REF, HERMES_MODEL_REF } from '@shared/types'

afterEach(cleanup)

describe('Composer — Ursa glow', () => {
  it('applies the composer--ursa class when modelRef is the Ursa sentinel', () => {
    useAppStore.setState({ modelRef: URSA_MODEL_REF, providers: [] } as never)
    const { container } = render(<Composer onSend={() => {}} />)
    expect(container.querySelector('.composer')?.className).toContain('composer--ursa')
  })

  it('does not apply the class for a concrete model', () => {
    useAppStore.setState({ modelRef: 'anthropic/claude-sonnet-5', providers: [] } as never)
    const { container } = render(<Composer onSend={() => {}} />)
    expect(container.querySelector('.composer')?.className).not.toContain('composer--ursa')
  })
})

describe('Composer — picker swap (Ursa vs concrete model)', () => {
  it('renders the Ursa ModePicker (not EffortPicker) when the model is Ursa', () => {
    useAppStore.setState({ modelRef: URSA_MODEL_REF, providers: [] } as never)
    const { container } = render(<Composer onSend={() => {}} />)
    expect(container.querySelector('.ursa-mode-picker')).toBeTruthy()
    expect(container.querySelector('.effort-picker')).toBeNull()
  })

  it('renders EffortPicker (not the Ursa ModePicker) for a concrete model', () => {
    useAppStore.setState({ modelRef: 'anthropic/claude-sonnet-5', providers: [] } as never)
    const { container } = render(<Composer onSend={() => {}} />)
    expect(container.querySelector('.effort-picker')).toBeTruthy()
    expect(container.querySelector('.ursa-mode-picker')).toBeNull()
  })
})

describe('Composer — Hermes lean mode (Task 11)', () => {
  it('hides the model, mode, and effort/web-search picker controls for a Hermes conversation', () => {
    useAppStore.setState({ modelRef: HERMES_MODEL_REF, providers: [] } as never)
    const { container } = render(<Composer onSend={() => {}} />)
    expect(container.querySelector('.model-picker')).toBeNull()
    expect(container.querySelector('.mode-picker')).toBeNull()
    expect(container.querySelector('.effort-picker')).toBeNull()
    expect(container.querySelector('.ursa-mode-picker')).toBeNull()
  })

  it('keeps the model, mode, and effort picker controls for a normal conversation', () => {
    useAppStore.setState({ modelRef: 'anthropic/claude-sonnet-5', providers: [] } as never)
    const { container } = render(<Composer onSend={() => {}} />)
    expect(container.querySelector('.model-picker')).toBeTruthy()
    expect(container.querySelector('.mode-picker')).toBeTruthy()
    expect(container.querySelector('.effort-picker')).toBeTruthy()
  })

  it('still shows the attachment picker and mic controls for a Hermes conversation', () => {
    useAppStore.setState({ modelRef: HERMES_MODEL_REF, providers: [] } as never)
    const { container } = render(<Composer onSend={() => {}} />)
    expect(container.querySelector('.add-context')).toBeTruthy()
    expect(container.querySelector('.mic-btn')).toBeTruthy()
    expect(container.querySelector('textarea')).toBeTruthy()
  })

  // Task 8's newHermesConversation (and openConvo's refConfigured guard, which
  // isn't special-cased for HERMES_MODEL_REF the way it is for Ursa/Ursus)
  // don't reliably sync the transient top-level `modelRef` to the Hermes
  // sentinel -- see Task 11 report. Lean mode must still engage off the
  // active conversation's own persisted modelRef in that case.
  it('hides the picker controls when only the active conversation record (not the transient modelRef) is Hermes', () => {
    useAppStore.setState({
      modelRef: 'anthropic/claude-sonnet-5',
      providers: [],
      conversations: {
        c1: { events: [], environment: 'local', modelRef: HERMES_MODEL_REF }
      }
    } as never)
    const { container } = render(<Composer onSend={() => {}} conversationId="c1" />)
    expect(container.querySelector('.model-picker')).toBeNull()
    expect(container.querySelector('.mode-picker')).toBeNull()
    expect(container.querySelector('.effort-picker')).toBeNull()
  })
})
