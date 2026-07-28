// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Event } from '@shared/types'
import { useAppStore } from '../state/store'
import { ArtifactViewer } from './ArtifactViewer'

const resolvePlanReview = vi.fn()
const loadArtifactComments = vi.fn().mockResolvedValue(undefined)
const addArtifactComment = vi.fn().mockResolvedValue(undefined)
const originalState = useAppStore.getState()

const plan = (artifactId: string): Extract<Event, { type: 'artifact' }> => ({
  type: 'artifact',
  id: `event-${artifactId}`,
  artifactId,
  artifactType: 'plan',
  version: 1,
  title: `Plan ${artifactId}`,
  status: 'pending-review',
  body: 'Implementation plan'
})

const pendingCall = (artifactId: string): Extract<Event, { type: 'tool_call' }> => ({
  type: 'tool_call',
  id: `call-${artifactId}`,
  tool: 'submit_plan',
  input: { artifactId },
  approvalState: 'pending'
})

function renderViewer(artifactId = 'one'): ReturnType<typeof render> {
  const selected = plan(artifactId)
  return render(
    <ArtifactViewer
      selected={selected}
      versions={[selected]}
      convoEvents={[selected, pendingCall(artifactId)]}
      onSelectVersion={vi.fn()}
    />
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  resolvePlanReview.mockReset()
  loadArtifactComments.mockClear()
  addArtifactComment.mockClear()
  useAppStore.setState({
    auxSelection: { kind: 'artifact', artifactId: 'one' },
    artifactComments: {},
    artifactPaneFocusFeedback: 0,
    resolvePlanReview,
    loadArtifactComments,
    addArtifactComment
  } as never)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  useAppStore.setState({
    resolvePlanReview: originalState.resolvePlanReview,
    loadArtifactComments: originalState.loadArtifactComments,
    addArtifactComment: originalState.addArtifactComment
  } as never)
})

describe('ArtifactViewer plan resolution feedback', () => {
  it('shows an accessible Approved acknowledgment after successful proceed', async () => {
    resolvePlanReview.mockResolvedValue(true)
    renderViewer()

    fireEvent.click(screen.getByRole('button', { name: 'Proceed' }))
    await act(async () => {
      await Promise.resolve()
    })

    expect(resolvePlanReview).toHaveBeenCalledWith('call-one', true)
    expect(screen.getByRole('status')).toHaveTextContent('Approved')

    act(() => {
      vi.advanceTimersByTime(1199)
    })
    expect(screen.getByRole('status')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('shows Feedback sent only after a successful review request', async () => {
    resolvePlanReview.mockResolvedValue(true)
    renderViewer()
    const feedback = screen.getByPlaceholderText('Feedback for the agent…')
    fireEvent.change(feedback, { target: { value: 'Please tighten the tests' } })

    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await act(async () => {
      await Promise.resolve()
    })

    expect(resolvePlanReview).toHaveBeenCalledWith('call-one', false, 'Please tighten the tests')
    expect(screen.getByRole('status')).toHaveTextContent('Feedback sent')
  })

  it('disables both actions and prevents duplicate resolution while pending', () => {
    resolvePlanReview.mockReturnValue(new Promise<boolean>(() => {}))
    renderViewer()
    const proceed = screen.getByRole('button', { name: 'Proceed' })
    const review = screen.getByRole('button', { name: 'Review' })

    fireEvent.click(proceed)
    expect(proceed).toBeDisabled()
    expect(review).toBeDisabled()
    fireEvent.click(proceed)

    expect(resolvePlanReview).toHaveBeenCalledTimes(1)
  })

  it('retains editable review state and shows no success when resolution fails', async () => {
    resolvePlanReview.mockResolvedValue(false)
    renderViewer()
    const feedback = screen.getByPlaceholderText('Feedback for the agent…')
    fireEvent.change(feedback, { target: { value: 'Keep this text' } })

    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await act(async () => {
      await Promise.resolve()
    })

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(feedback).toHaveValue('Keep this text')
    expect(screen.getByRole('button', { name: 'Proceed' })).not.toBeDisabled()
  })

  it('clears acknowledgment immediately when the selected artifact changes', async () => {
    resolvePlanReview.mockResolvedValue(true)
    const view = renderViewer()
    fireEvent.click(screen.getByRole('button', { name: 'Proceed' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByRole('status')).toHaveTextContent('Approved')

    const next = plan('two')
    view.rerender(
      <ArtifactViewer
        selected={next}
        versions={[next]}
        convoEvents={[next, pendingCall('two')]}
        onSelectVersion={vi.fn()}
      />
    )

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
