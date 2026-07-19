// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { useAppStore } from '../../state/store'
import { UrsaStepDivider } from './UrsaStepDivider'
import type { Event } from '@shared/types'

afterEach(cleanup)

const stepEvent = (): Extract<Event, { type: 'ursa_step' }> =>
  ({
    type: 'ursa_step',
    id: 's1',
    index: 2,
    total: 3,
    role: 'reviewer',
    modelRef: 'anthropic/claude-sonnet',
    subtask: 'review the work'
  }) as never

describe('UrsaStepDivider', () => {
  it('renders "Step i/N", the role, and the resolved model label', () => {
    useAppStore.setState({
      providers: [
        {
          id: 'anthropic',
          label: 'Anthropic',
          color: '#4c8dff',
          models: [{ id: 'claude-sonnet', label: 'Claude Sonnet 5' }]
        }
      ] as never
    })
    render(<UrsaStepDivider event={stepEvent()} />)
    expect(screen.getByText('Step 2/3')).toBeTruthy()
    expect(screen.getByText('reviewer')).toBeTruthy()
    expect(screen.getByText('Claude Sonnet 5')).toBeTruthy()
  })

  it('carries a separator role with a readable aria-label', () => {
    render(<UrsaStepDivider event={stepEvent()} />)
    const sep = screen.getByRole('separator')
    expect(sep.getAttribute('aria-label')).toContain('Step 2/3')
    expect(sep.getAttribute('aria-label')).toContain('reviewer')
  })
})
