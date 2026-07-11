// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useAppStore } from '../../state/store'
import { ToolStep } from './ToolStep'
import type { Event } from '@shared/types'

afterEach(cleanup)

describe('ToolStep run_command_unsandboxed pending card', () => {
  const call: Event = {
    type: 'tool_call',
    id: 'u1',
    tool: 'run_command',
    input: { command: 'npm i', unsandboxed: true },
    approvalState: 'pending'
  }

  it('renders "Run npm i outside the sandbox?" and the three options', () => {
    useAppStore.setState({ approveTool: vi.fn() as never, addPermissionRule: vi.fn() as never })

    render(<ToolStep call={call as never} convoId="convo1" />)

    expect(screen.getAllByText('npm i').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/outside the sandbox\?/).length).toBeGreaterThan(0)
    expect(screen.getByText(/Yes, run it unsandboxed this time/)).toBeTruthy()
    expect(screen.getByText(/Yes, always run unsandboxed/)).toBeTruthy()
    expect(screen.getByText(/No, keep it sandboxed/)).toBeTruthy()
  })

  it('clicking "Yes, run it unsandboxed this time" calls approveTool(callId, true)', () => {
    const approveTool = vi.fn()
    useAppStore.setState({ approveTool: approveTool as never, addPermissionRule: vi.fn() as never })

    render(<ToolStep call={call as never} convoId="convo1" />)
    fireEvent.click(screen.getByText(/Yes, run it unsandboxed this time/))

    expect(approveTool).toHaveBeenCalledWith('u1', true)
  })

  it('clicking "No, keep it sandboxed" calls approveTool(callId, false)', () => {
    const approveTool = vi.fn()
    useAppStore.setState({ approveTool: approveTool as never, addPermissionRule: vi.fn() as never })

    render(<ToolStep call={call as never} convoId="convo1" />)
    fireEvent.click(screen.getByText(/No, keep it sandboxed/))

    expect(approveTool).toHaveBeenCalledWith('u1', false)
  })

  it('opening "always" + a cell calls addPermissionRule with an unsandboxed rule then approveTool(callId, true)', () => {
    const approveTool = vi.fn()
    const addPermissionRule = vi.fn()
    useAppStore.setState({
      approveTool: approveTool as never,
      addPermissionRule: addPermissionRule as never,
      conversations: { convo1: { projectPath: '/proj' } } as never
    })

    render(<ToolStep call={call as never} convoId="convo1" />)
    fireEvent.click(screen.getByText(/Yes, always run unsandboxed/))
    fireEvent.click(screen.getByText('This exact command, everywhere'))

    expect(addPermissionRule).toHaveBeenCalledWith({
      scope: 'global',
      action: 'unsandboxed',
      match: 'npm i',
      effect: 'allow'
    })
    expect(approveTool).toHaveBeenCalledWith('u1', true)
  })
})

describe('ToolStep resolved run_command sandboxed badge + hint', () => {
  const resolvedCall: Event = {
    type: 'tool_call',
    id: 'r1',
    tool: 'run_command',
    input: { command: 'ls -la' },
    approvalState: 'approved'
  }

  function makeResult(overrides: Partial<Extract<Event, { type: 'tool_result' }>>): Event {
    return {
      type: 'tool_result',
      id: 'res1',
      callId: 'r1',
      output: 'exit code 0',
      durationMs: 1,
      truncated: false,
      ...overrides
    } as Event
  }

  it('renders the "sandboxed" badge when sandboxed:true', () => {
    const result = makeResult({ sandboxed: true, output: 'exit code 0' })
    render(<ToolStep call={resolvedCall as never} result={result as never} convoId="convo1" />)

    expect(screen.getByText('sandboxed')).toBeTruthy()
  })

  it('renders the violation hint when sandboxed:true and exit code is nonzero', () => {
    const result = makeResult({ sandboxed: true, output: 'exit code 1\nsome error' })
    render(<ToolStep call={resolvedCall as never} result={result as never} convoId="convo1" />)

    expect(screen.getByText('sandboxed')).toBeTruthy()
    expect(screen.getByText(/may have been blocked by the sandbox/)).toBeTruthy()
  })

  it('renders neither badge nor hint when sandboxed is false/absent', () => {
    const result = makeResult({ sandboxed: false, output: 'exit code 1' })
    render(<ToolStep call={resolvedCall as never} result={result as never} convoId="convo1" />)

    expect(screen.queryByText('sandboxed')).toBeNull()
    expect(screen.queryByText(/may have been blocked by the sandbox/)).toBeNull()
  })

  it('renders the badge but not the hint when sandboxed:true and exit code is 0', () => {
    const result = makeResult({ sandboxed: true, output: 'exit code 0' })
    render(<ToolStep call={resolvedCall as never} result={result as never} convoId="convo1" />)

    expect(screen.getByText('sandboxed')).toBeTruthy()
    expect(screen.queryByText(/may have been blocked by the sandbox/)).toBeNull()
  })
})
