// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { BearcodeApi, Event } from '@shared/types'
import { HermesToolStep } from './HermesToolStep'

const resolveApproval = vi.fn(() => Promise.resolve())

function call(overrides: Partial<Extract<Event, { type: 'hermes_tool_call' }>> = {}) {
  return {
    type: 'hermes_tool_call',
    id: 'call-1',
    name: 'vendor.arbitrary_tool',
    label: 'Vendor Arbitrary Tool',
    status: 'running',
    ...overrides
  } as Extract<Event, { type: 'hermes_tool_call' }>
}

beforeEach(() => {
  resolveApproval.mockReset()
  resolveApproval.mockResolvedValue(undefined)
  ;(window as unknown as { bearcode: BearcodeApi }).bearcode = {
    hermes: { resolveApproval }
  } as unknown as BearcodeApi
})
afterEach(cleanup)

describe('HermesToolStep', () => {
  it('renders an arbitrary native tool name and label without local ToolName coercion', () => {
    render(<HermesToolStep call={call()} convoId="conversation-id" />)

    expect(screen.getByText('Vendor Arbitrary Tool')).toBeInTheDocument()
    expect(screen.getByText('vendor.arbitrary_tool')).toBeInTheDocument()
    expect(screen.getByText(/running/i)).toBeInTheDocument()
  })

  it('renders the paired result status and duration', () => {
    const result = {
      type: 'hermes_tool_result',
      id: 'result-1',
      callId: 'call-1',
      status: 'completed',
      durationMs: 1500
    } as const

    render(<HermesToolStep call={call()} result={result} convoId="conversation-id" />)

    expect(screen.getByText(/completed/i)).toBeInTheDocument()
    expect(screen.getByText(/1\.5s/)).toBeInTheDocument()
  })

  it('shows exactly the approval decisions allowed by the native call flags', () => {
    render(
      <HermesToolStep
        call={call({
          status: 'awaiting-approval',
          requestId: 'request-id',
          command: 'deploy --production',
          description: 'Deploy the current build',
          allowSession: false,
          allowPermanent: true
        })}
        convoId="conversation-id"
        interactive
      />
    )

    expect(screen.getByText('deploy --production')).toBeInTheDocument()
    expect(screen.getByText('Deploy the current build')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Allow Once' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Allow Session' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Always Allow' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument()
  })

  it('routes Allow Once through the store/preload boundary once and disables all choices', () => {
    render(
      <HermesToolStep
        call={call({ status: 'awaiting-approval', requestId: 'request-id' })}
        convoId="conversation-id"
        interactive
      />
    )

    const allow = screen.getByRole('button', { name: 'Allow Once' })
    fireEvent.click(allow)
    fireEvent.click(allow)

    expect(resolveApproval).toHaveBeenCalledTimes(1)
    expect(resolveApproval).toHaveBeenCalledWith('conversation-id', 'request-id', 'once')
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled()
  })

  it('routes Deny through the store/preload boundary', () => {
    render(
      <HermesToolStep
        call={call({ status: 'awaiting-approval', requestId: 'request-id' })}
        convoId="conversation-id"
        interactive
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))

    expect(resolveApproval).toHaveBeenCalledWith('conversation-id', 'request-id', 'deny')
  })

  it('shows a controlled error and lets the same approval retry after IPC rejects', async () => {
    resolveApproval
      .mockRejectedValueOnce(new Error('gateway unavailable'))
      .mockResolvedValueOnce(undefined)
    render(
      <HermesToolStep
        call={call({ status: 'awaiting-approval', requestId: 'request-id' })}
        convoId="conversation-id"
        interactive
      />
    )

    const allow = screen.getByRole('button', { name: 'Allow Once' })
    fireEvent.click(allow)
    fireEvent.click(allow)
    expect(resolveApproval).toHaveBeenCalledTimes(1)

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not submit approval/i)
    expect(allow).toBeEnabled()

    fireEvent.click(allow)
    await waitFor(() => expect(resolveApproval).toHaveBeenCalledTimes(2))
    expect(allow).toBeDisabled()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
