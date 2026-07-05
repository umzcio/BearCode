import { describe, it, expect } from 'vitest'
import type { Event } from '@shared/types'
import { deriveActivity, formatElapsed } from './activity'

const call = (id: string, tool: string, input: unknown): Event =>
  ({ type: 'tool_call', id, tool, input, approvalState: 'auto' }) as Event
const result = (id: string, callId: string): Event =>
  ({ type: 'tool_result', id, callId, output: '', durationMs: 0, truncated: false }) as Event
const thinking = (id: string): Event =>
  ({ type: 'thinking', id, text: 'x', durationMs: 10 }) as Event

describe('deriveActivity', () => {
  it('shows the approval label when awaiting approval', () => {
    expect(deriveActivity('awaiting-approval', [])).toEqual({
      label: 'Waiting for your approval',
      tone: 'attention'
    })
  })
  it('labels an in-flight run_command with its command', () => {
    expect(
      deriveActivity('running', [call('c1', 'run_command', { command: 'open index.html' })])
    ).toEqual({ label: 'Running: open index.html', tone: 'busy' })
  })
  it('truncates a long command to 40 chars', () => {
    const long = 'a'.repeat(60)
    const out = deriveActivity('running', [call('c1', 'run_command', { command: long })])
    expect(out.label).toBe(`Running: ${'a'.repeat(40)}…`)
  })
  it('labels an in-flight write_file with the file basename', () => {
    expect(
      deriveActivity('running', [call('c1', 'write_file', { path: '/a/b/index.html' })]).label
    ).toBe('Writing index.html…')
  })
  it('reads the write_file path from file_path too (the other real key)', () => {
    expect(
      deriveActivity('running', [call('c1', 'write_file', { file_path: '/a/b/styles.css' })]).label
    ).toBe('Writing styles.css…')
  })
  it('labels an in-flight read tool as Reading', () => {
    expect(deriveActivity('running', [call('c1', 'ls', { path: '.' })]).label).toBe('Reading…')
  })
  it('says Thinking when the last meaningful event is a completed thought', () => {
    const events = [call('c1', 'ls', { path: '.' }), result('r1', 'c1'), thinking('t1')]
    expect(deriveActivity('running', events).label).toBe('Thinking…')
  })
  it('says Working after a tool completes with no newer event (model generating)', () => {
    const events = [call('c1', 'write_file', { path: '/x.html' }), result('r1', 'c1')]
    expect(deriveActivity('running', events).label).toBe('Working…')
  })
  it('says Working for an empty event list', () => {
    expect(deriveActivity('running', [])).toEqual({ label: 'Working…', tone: 'busy' })
  })

  const pendingCall = (id: string, tool: string): Event =>
    ({ type: 'tool_call', id, tool, input: {}, approvalState: 'pending' }) as Event

  it('says Waiting for plan review when the pending call is submit_plan (Ba4)', () => {
    expect(deriveActivity('awaiting-approval', [pendingCall('c1', 'submit_plan')])).toEqual({
      label: 'Waiting for plan review',
      tone: 'attention'
    })
  })
  it('keeps the generic approval copy for a pending run_command', () => {
    expect(deriveActivity('awaiting-approval', [pendingCall('c1', 'run_command')]).label).toBe(
      'Waiting for your approval'
    )
  })
  it('follows the FIRST pending card when a command and a plan are both parked', () => {
    // The status bar's click jumps to the first pending card (its anchor and
    // hotkeys, ToolStep useIsFirstPendingCard) -- the label must describe
    // that card, not the plan parked behind it.
    const events = [pendingCall('c1', 'run_command'), pendingCall('c2', 'submit_plan')]
    expect(deriveActivity('awaiting-approval', events).label).toBe('Waiting for your approval')
  })
})

describe('formatElapsed', () => {
  it('shows seconds under a minute', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(3)).toBe('3s')
    expect(formatElapsed(59)).toBe('59s')
  })
  it('shows m:ss at and past a minute', () => {
    expect(formatElapsed(60)).toBe('1:00')
    expect(formatElapsed(75)).toBe('1:15')
    expect(formatElapsed(612)).toBe('10:12')
  })
})
