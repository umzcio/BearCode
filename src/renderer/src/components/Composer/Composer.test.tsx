// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { Composer } from './Composer'
import { useAppStore } from '../../state/store'
import { URSA_MODEL_REF } from '@shared/types'

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
