// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { BearcodeApi, Event } from '@shared/types'
import { HermesClarifyCard } from './HermesClarifyCard'

const resolveClarification = vi.fn(() => Promise.resolve())
const event = {
  type: 'hermes_clarification',
  id: 'clarify-1',
  requestId: 'request-id',
  question: 'Which environment?',
  choices: ['Staging', 'Production'],
  state: 'pending'
} as Extract<Event, { type: 'hermes_clarification' }>

beforeEach(() => {
  resolveClarification.mockReset()
  resolveClarification.mockResolvedValue(undefined)
  ;(window as unknown as { bearcode: BearcodeApi }).bearcode = {
    hermes: { resolveClarification }
  } as unknown as BearcodeApi
})
afterEach(cleanup)

describe('HermesClarifyCard', () => {
  it('submits a clarification choice as its exact string once', () => {
    render(<HermesClarifyCard event={event} convoId="conversation-id" interactive />)

    const choice = screen.getByRole('button', { name: 'Production' })
    fireEvent.click(choice)
    fireEvent.click(choice)

    expect(resolveClarification).toHaveBeenCalledTimes(1)
    expect(resolveClarification).toHaveBeenCalledWith('conversation-id', 'request-id', 'Production')
    expect(screen.getByRole('button', { name: 'Staging' })).toBeDisabled()
  })

  it('requires non-empty text for Other and submits that text once', () => {
    render(<HermesClarifyCard event={event} convoId="conversation-id" interactive />)

    fireEvent.click(screen.getByRole('button', { name: 'Other' }))
    const input = screen.getByRole('textbox', { name: 'Other response' })
    const submit = screen.getByRole('button', { name: 'Submit response' })
    expect(input).toBeRequired()
    expect(submit).toBeDisabled()

    fireEvent.change(input, { target: { value: 'Canary' } })
    fireEvent.click(submit)
    fireEvent.click(submit)

    expect(resolveClarification).toHaveBeenCalledTimes(1)
    expect(resolveClarification).toHaveBeenCalledWith('conversation-id', 'request-id', 'Canary')
    expect(input).toBeDisabled()
  })

  it('renders pending transcript copies passively', () => {
    const { container } = render(<HermesClarifyCard event={event} convoId="conversation-id" />)

    expect(screen.getByText('Which environment?')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
    expect(container.querySelector('.step-row')).not.toBeNull()
    expect(container.querySelector('.approval-card')).toBeNull()
  })

  it('shows a controlled error and lets the same clarification retry after IPC rejects', async () => {
    resolveClarification
      .mockRejectedValueOnce(new Error('gateway unavailable'))
      .mockResolvedValueOnce(undefined)
    render(<HermesClarifyCard event={event} convoId="conversation-id" interactive />)

    const choice = screen.getByRole('button', { name: 'Production' })
    fireEvent.click(choice)
    fireEvent.click(choice)
    expect(resolveClarification).toHaveBeenCalledTimes(1)

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not submit response/i)
    expect(choice).toBeEnabled()

    fireEvent.click(choice)
    await waitFor(() => expect(resolveClarification).toHaveBeenCalledTimes(2))
    expect(choice).toBeDisabled()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
