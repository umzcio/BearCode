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
