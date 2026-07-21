// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ToolStep, PinnedApprovalArea } from './ToolStep'
import { useAppStore } from '../../state/store'
import type { Event } from '@shared/types'

// The approve path is fire-and-forget IPC; stub it so a hotkey press asserts
// the wiring without reaching a real preload bridge.
const approve = vi.fn()
beforeEach(() => {
  approve.mockClear()
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.bearcode = {
    tools: { approve }
  }
})

afterEach(cleanup)

const command = (id: string): Event =>
  ({
    type: 'tool_call',
    id,
    tool: 'run_command',
    input: { command: 'ls' },
    approvalState: 'pending'
  }) as unknown as Event

const pipelineCall = (id: string, approvalState: string): Event =>
  ({
    type: 'tool_call',
    id,
    tool: 'ursa_pipeline',
    input: { steps: [] },
    approvalState
  }) as unknown as Event

function seedEvents(events: Event[]): void {
  useAppStore.setState({
    conversations: { c1: { id: 'c1', loaded: true, events, runState: 'idle' } as never }
  })
}

function renderPinned(call: Event): void {
  render(
    <PinnedApprovalArea.Provider value={true}>
      <ToolStep call={call as never} convoId="c1" />
    </PinnedApprovalArea.Provider>
  )
}

// The number chips and their hotkeys belong to the pinned approval card above
// the composer. That used to be decided by re-scanning the store for the first
// pending tool_call and comparing ids against the pinned call -- two
// independent passes that had to agree. A pending `ursa_pipeline` consent call
// (only Ursa/Ursus ever create one) could win that scan while ConversationView
// had pinned a different card, and the pinned card then rendered with NO chips
// and NO working hotkeys. Being pinned is now the whole condition.
describe('pinned approval card owns the number chips (router regression)', () => {
  it('shows chips on a plain conversation', () => {
    seedEvents([command('x1')])
    renderPinned(command('x1'))
    expect(screen.getByText('1')).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy()
  })

  it('shows chips with an already-approved pipeline earlier in the conversation', () => {
    seedEvents([pipelineCall('p1', 'approved'), command('x1')])
    renderPinned(command('x1'))
    expect(screen.getByText('1')).toBeTruthy()
  })

  // The actual reported bug: chips vanished on Ursa/Ursus command approvals.
  it('STILL shows chips while a pipeline consent call is itself pending', () => {
    seedEvents([pipelineCall('p1', 'pending'), command('x1')])
    renderPinned(command('x1'))
    expect(screen.getByText('1')).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy()
  })

  it('keeps the hotkeys live in that same case, not just the chips', () => {
    seedEvents([pipelineCall('p1', 'pending'), command('x1')])
    renderPinned(command('x1'))
    fireEvent.keyDown(window, { key: '1' })
    expect(approve).toHaveBeenCalledWith('x1', true)
  })

  it('an UNPINNED (inline) copy never renders chips, so one keypress cannot answer two cards', () => {
    seedEvents([command('x1')])
    render(<ToolStep call={command('x1') as never} convoId="c1" />)
    expect(screen.queryByText('1')).toBeNull()
  })
})
