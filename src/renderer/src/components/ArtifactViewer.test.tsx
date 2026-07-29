// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BearcodeApi, Event } from '@shared/types'
import { useAppStore } from '../state/store'
import { ArtifactViewer } from './ArtifactViewer'

const resolvePlanReview = vi.fn()
const loadArtifactComments = vi.fn().mockResolvedValue(undefined)
const addArtifactComment = vi.fn().mockResolvedValue(undefined)
const writeClipboard = vi.fn()
const saveMarkdown = vi.fn()
const originalState = useAppStore.getState()
const showToast = vi.fn()
let bearcodeBefore: PropertyDescriptor | undefined

function controlledPromise<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

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

function selectArtifactText(text: string): void {
  const element = screen.getByText(text)
  const node = element.firstChild
  if (!node) throw new Error('Expected rendered artifact text')
  const range = document.createRange()
  range.setStart(node, 0)
  range.setEnd(node, text.length)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  fireEvent.mouseUp(element)
}

function openCommentComposer(text = 'Implementation plan'): HTMLTextAreaElement {
  selectArtifactText(text)
  return screen.getByPlaceholderText('Add a comment…')
}

beforeEach(() => {
  vi.useFakeTimers()
  bearcodeBefore = Object.getOwnPropertyDescriptor(window, 'bearcode')
  resolvePlanReview.mockReset()
  loadArtifactComments.mockClear()
  addArtifactComment.mockReset()
  addArtifactComment.mockResolvedValue(undefined)
  writeClipboard.mockReset()
  writeClipboard.mockResolvedValue(undefined)
  saveMarkdown.mockReset()
  saveMarkdown.mockResolvedValue('cancelled')
  showToast.mockReset()
  ;(window as unknown as { bearcode: BearcodeApi }).bearcode = {
    clipboard: { write: writeClipboard },
    artifacts: { saveMarkdown }
  } as unknown as BearcodeApi
  useAppStore.setState({
    auxSelection: { kind: 'artifact', artifactId: 'one' },
    artifactComments: {},
    artifactPaneFocusFeedback: 0,
    resolvePlanReview,
    loadArtifactComments,
    addArtifactComment,
    showToast
  } as never)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  if (bearcodeBefore) Object.defineProperty(window, 'bearcode', bearcodeBefore)
  else Reflect.deleteProperty(window, 'bearcode')
  useAppStore.setState({
    resolvePlanReview: originalState.resolvePlanReview,
    loadArtifactComments: originalState.loadArtifactComments,
    addArtifactComment: originalState.addArtifactComment,
    showToast: originalState.showToast
  } as never)
})

describe('ArtifactViewer copy and Markdown export', () => {
  it('copies the exact source Markdown and toasts only after the clipboard write succeeds', async () => {
    const write = controlledPromise<void>()
    writeClipboard.mockReturnValue(write.promise)
    const selected = {
      ...plan('one'),
      body: '# Exact Markdown\n\nUnicode ✅\n`\\u0000-like`'
    }
    render(
      <ArtifactViewer
        selected={selected}
        versions={[selected]}
        convoEvents={[selected, pendingCall('one')]}
        onSelectVersion={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Copy Markdown' }))

    expect(writeClipboard).toHaveBeenCalledExactlyOnceWith(selected.body)
    expect(showToast).not.toHaveBeenCalled()

    await act(async () => {
      write.resolve()
      await write.promise
    })

    expect(showToast).toHaveBeenCalledExactlyOnceWith('Markdown copied')
  })

  it('reports clipboard failures without a success toast', async () => {
    writeClipboard.mockRejectedValueOnce(new Error('clipboard unavailable'))
    renderViewer()

    fireEvent.click(screen.getByRole('button', { name: 'Copy Markdown' }))
    await act(async () => {
      await Promise.resolve()
    })

    expect(showToast).toHaveBeenCalledExactlyOnceWith('Could not copy Markdown')
    expect(showToast).not.toHaveBeenCalledWith('Markdown copied')
  })

  it('passes only the selected opaque ID and toasts after a successful export', async () => {
    const save = controlledPromise<'saved' | 'cancelled'>()
    saveMarkdown.mockReturnValue(save.promise)
    renderViewer()

    const exportButton = screen.getByRole('button', { name: 'Export…' })
    fireEvent.click(exportButton)

    expect(saveMarkdown).toHaveBeenCalledExactlyOnceWith('one')
    expect(exportButton).toBeDisabled()
    expect(showToast).not.toHaveBeenCalled()

    await act(async () => {
      save.resolve('saved')
      await save.promise
    })

    expect(showToast).toHaveBeenCalledExactlyOnceWith('Artifact exported')
    expect(exportButton).not.toBeDisabled()
  })

  it('keeps cancellation silent and restores the export control', async () => {
    saveMarkdown.mockResolvedValueOnce('cancelled')
    renderViewer()

    const exportButton = screen.getByRole('button', { name: 'Export…' })
    fireEvent.click(exportButton)
    await act(async () => {
      await Promise.resolve()
    })

    expect(showToast).not.toHaveBeenCalled()
    expect(exportButton).not.toBeDisabled()
  })

  it('reports export rejection and restores the export control', async () => {
    saveMarkdown.mockRejectedValueOnce(new Error('disk full'))
    renderViewer()

    const exportButton = screen.getByRole('button', { name: 'Export…' })
    fireEvent.click(exportButton)
    await act(async () => {
      await Promise.resolve()
    })

    expect(showToast).toHaveBeenCalledExactlyOnceWith('Could not export artifact')
    expect(exportButton).not.toBeDisabled()
  })

  it('disables export and suppresses duplicate dialogs while one is pending', () => {
    const save = controlledPromise<'saved' | 'cancelled'>()
    saveMarkdown.mockReturnValue(save.promise)
    renderViewer()

    const exportButton = screen.getByRole('button', { name: 'Export…' })
    fireEvent.click(exportButton)
    fireEvent.click(exportButton)

    expect(exportButton).toBeDisabled()
    expect(saveMarkdown).toHaveBeenCalledTimes(1)
  })

  it('ignores a stale successful completion after selection changes', async () => {
    const save = controlledPromise<'saved' | 'cancelled'>()
    saveMarkdown.mockReturnValue(save.promise)
    const view = renderViewer()
    fireEvent.click(screen.getByRole('button', { name: 'Export…' }))

    const next = plan('two')
    view.rerender(
      <ArtifactViewer
        selected={next}
        versions={[next]}
        convoEvents={[next, pendingCall('two')]}
        onSelectVersion={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: 'Export…' })).not.toBeDisabled()

    await act(async () => {
      save.resolve('saved')
      await save.promise
    })

    expect(showToast).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Export…' })).not.toBeDisabled()
  })

  it('ignores a stale rejection after selection changes', async () => {
    const save = controlledPromise<'saved' | 'cancelled'>()
    saveMarkdown.mockReturnValue(save.promise)
    const view = renderViewer()
    fireEvent.click(screen.getByRole('button', { name: 'Export…' }))

    const next = plan('two')
    view.rerender(
      <ArtifactViewer
        selected={next}
        versions={[next]}
        convoEvents={[next, pendingCall('two')]}
        onSelectVersion={vi.fn()}
      />
    )

    await act(async () => {
      save.reject(new Error('old dialog failed'))
      try {
        await save.promise
      } catch {
        // The component owns the rejection.
      }
    })

    expect(showToast).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Export…' })).not.toBeDisabled()
  })
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

describe('ArtifactViewer artifact comment insertion', () => {
  it('disables comment actions and blocks a duplicate insertion while the first insertion is pending', () => {
    const insertion = controlledPromise<void>()
    addArtifactComment.mockReturnValue(insertion.promise)
    renderViewer()
    const body = openCommentComposer()
    fireEvent.change(body, { target: { value: '  Keep exact spacing  ' } })

    const add = screen.getByRole('button', { name: 'Add comment' })
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    fireEvent.click(add)
    fireEvent.click(add)

    expect(addArtifactComment).toHaveBeenCalledTimes(1)
    expect(addArtifactComment).toHaveBeenCalledWith(
      'one',
      'Implementation plan',
      'Keep exact spacing'
    )
    expect(add).toBeDisabled()
    expect(cancel).toBeDisabled()
    expect(body).toBeDisabled()
    expect(body).toHaveValue('  Keep exact spacing  ')
    expect(screen.getByText('Implementation plan', { selector: 'blockquote' })).toBeInTheDocument()
  })

  it('clears the exact quote and body only after a successful insertion resolves', async () => {
    const insertion = controlledPromise<void>()
    addArtifactComment.mockReturnValue(insertion.promise)
    renderViewer()
    const body = openCommentComposer()
    fireEvent.change(body, { target: { value: '  Complete the test plan  ' } })

    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }))
    expect(screen.getByText('Implementation plan', { selector: 'blockquote' })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Add a comment…')).toHaveValue('  Complete the test plan  ')

    await act(async () => {
      insertion.resolve()
      await insertion.promise
    })

    expect(screen.queryByPlaceholderText('Add a comment…')).not.toBeInTheDocument()
    expect(
      screen.queryByText('Implementation plan', { selector: 'blockquote' })
    ).not.toBeInTheDocument()
  })

  it('retains the exact editable quote and body and reports one described error when insertion rejects', async () => {
    const insertion = controlledPromise<void>()
    addArtifactComment.mockReturnValue(insertion.promise)
    renderViewer()
    const body = openCommentComposer()
    fireEvent.change(body, { target: { value: '  Keep this exact body  ' } })

    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }))
    await act(async () => {
      insertion.reject(
        new Error(
          "Error invoking remote method 'artifacts:add-comment': Error: Storage unavailable"
        )
      )
      try {
        await insertion.promise
      } catch {
        // The component handles this rejection.
      }
    })

    expect(screen.getByText('Implementation plan', { selector: 'blockquote' })).toBeInTheDocument()
    expect(body).toHaveValue('  Keep this exact body  ')
    expect(screen.getByRole('button', { name: 'Add comment' })).not.toBeDisabled()
    expect(showToast).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledWith('Storage unavailable')
  })

  it('does not let an old insertion clear a new artifact draft after selection changes', async () => {
    const insertion = controlledPromise<void>()
    addArtifactComment.mockReturnValue(insertion.promise)
    const view = renderViewer()
    const oldBody = openCommentComposer()
    fireEvent.change(oldBody, { target: { value: 'Old artifact draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }))

    const next = { ...plan('two'), body: 'Second plan text' }
    view.rerender(
      <ArtifactViewer
        selected={next}
        versions={[next]}
        convoEvents={[next, pendingCall('two')]}
        onSelectVersion={vi.fn()}
      />
    )
    const newBody = openCommentComposer('Second plan text')
    fireEvent.change(newBody, { target: { value: '  New artifact draft  ' } })

    await act(async () => {
      insertion.resolve()
      await insertion.promise
    })

    expect(screen.getByText('Second plan text', { selector: 'blockquote' })).toBeInTheDocument()
    expect(newBody).toHaveValue('  New artifact draft  ')
  })
})
