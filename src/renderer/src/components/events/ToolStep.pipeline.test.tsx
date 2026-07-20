// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useAppStore } from '../../state/store'
import { ToolStep, PinnedApprovalArea } from './ToolStep'
import type { Event } from '@shared/types'

afterEach(cleanup)

const pipelineCall = (approvalState: 'pending' | 'approved' | 'denied'): Event =>
  ({
    type: 'tool_call',
    id: 'pipe1',
    tool: 'ursa_pipeline',
    approvalState,
    input: {
      steps: [
        { role: 'coder', modelRef: 'anthropic/claude', subtask: 'Build the widget' },
        { role: 'reviewer', modelRef: 'openai/gpt', subtask: 'Review it' }
      ]
    }
  }) as Event

describe('ToolStep ursa_pipeline proposal card', () => {
  it('renders the teddy title + a numbered row per step with role and subtask', () => {
    render(<ToolStep call={pipelineCall('pending') as never} convoId="c1" />)
    expect(screen.getAllByText('Ursa proposes a pipeline').length).toBeGreaterThan(0)
    expect(screen.getByText('coder')).toBeTruthy()
    expect(screen.getByText('reviewer')).toBeTruthy()
    expect(screen.getByText('Build the widget')).toBeTruthy()
    expect(screen.getByText('Review it')).toBeTruthy()
  })

  it('shows Ursus copy and icon when the conversation\'s modelRef is the Ursus sentinel', () => {
    useAppStore.setState({ modelRef: 'ursus/auto' } as never)
    try {
      render(<ToolStep call={pipelineCall('pending') as never} convoId="c1" />)
      expect(screen.getAllByText('Ursus proposes a pipeline').length).toBeGreaterThan(0)
      expect(screen.queryByText('Ursa proposes a pipeline')).toBeNull()
    } finally {
      // This file has no global store reset between tests (afterEach only runs
      // RTL's cleanup) -- explicitly undo the modelRef override so later tests
      // in this file don't inherit it and silently render Ursus copy instead of
      // Ursa's default.
      useAppStore.setState({ modelRef: undefined } as never)
    }
  })

  it('Approve calls resolvePipeline(convoId, callId, true)', () => {
    const resolvePipeline = vi.fn()
    useAppStore.setState({ resolvePipeline: resolvePipeline as never })
    render(<ToolStep call={pipelineCall('pending') as never} convoId="c1" />)
    fireEvent.click(screen.getByText('Yes, run this pipeline'))
    expect(resolvePipeline).toHaveBeenCalledWith('c1', 'pipe1', true)
  })

  it('Deny calls resolvePipeline(convoId, callId, false)', () => {
    const resolvePipeline = vi.fn()
    useAppStore.setState({ resolvePipeline: resolvePipeline as never })
    render(<ToolStep call={pipelineCall('pending') as never} convoId="c1" />)
    fireEvent.click(screen.getByText('No, just answer normally'))
    expect(resolvePipeline).toHaveBeenCalledWith('c1', 'pipe1', false)
  })

  it('number-key hotkeys resolve only inside the pinned approval area', () => {
    const resolvePipeline = vi.fn()
    useAppStore.setState({
      resolvePipeline: resolvePipeline as never,
      conversations: {
        c1: { events: [pipelineCall('pending')] }
      } as never
    })
    render(
      <PinnedApprovalArea.Provider value={true}>
        <ToolStep call={pipelineCall('pending') as never} convoId="c1" />
      </PinnedApprovalArea.Provider>
    )
    fireEvent.keyDown(window, { key: '1' })
    expect(resolvePipeline).toHaveBeenCalledWith('c1', 'pipe1', true)
  })

  it('renders a compact resolved card after approval (replay path)', () => {
    render(<ToolStep call={pipelineCall('approved') as never} convoId="c1" />)
    expect(screen.getByText('Pipeline approved')).toBeTruthy()
  })

  it('renders a compact resolved card after denial (replay path)', () => {
    render(<ToolStep call={pipelineCall('denied') as never} convoId="c1" />)
    expect(screen.getByText('Pipeline declined')).toBeTruthy()
  })
})
