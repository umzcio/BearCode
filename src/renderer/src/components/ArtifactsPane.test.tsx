// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BearcodeApi, Event } from '@shared/types'
import { mergeConvoEvent, useAppStore, type Convo } from '../state/store'
import { projectAuxEvents } from '../lib/auxEvents'
import { ArtifactsPane } from './ArtifactsPane'

const { attachmentPreviewRender } = vi.hoisted(() => ({ attachmentPreviewRender: vi.fn() }))

vi.mock('./AttachmentPreview/AttachmentPreview', () => ({
  AttachmentPreview: ({ attachmentId }: { attachmentId: string }) => {
    attachmentPreviewRender()
    return <div>Mock attachment preview {attachmentId}</div>
  }
}))

const preview = vi.fn()
const save = vi.fn()
const showToast = vi.fn()
const browserSetBounds = vi.fn().mockResolvedValue(undefined)
const browserShow = vi.fn().mockResolvedValue(undefined)
const browserHide = vi.fn().mockResolvedValue(undefined)
const readFile = vi.fn(() => new Promise<string>(() => {}))
const realShowToast = useAppStore.getState().showToast
const realLoadArtifactComments = useAppStore.getState().loadArtifactComments
const loadArtifactComments = vi.fn(() => Promise.resolve())

class ResizeObserverStub {
  observe = vi.fn()
  disconnect = vi.fn()
}

const returnedAttachment = {
  type: 'assistant_attachment',
  id: 'event_123',
  attachment: {
    id: 'att_123',
    name: 'verified-report.pdf',
    mime: 'application/pdf',
    kind: 'document',
    sizeBytes: 1536,
    sha256: 'a'.repeat(64)
  }
} satisfies Extract<Event, { type: 'assistant_attachment' }>

const returnedAttachmentTwo = {
  type: 'assistant_attachment',
  id: 'event_456',
  attachment: {
    id: 'att_456',
    name: 'follow-up-report.pdf',
    mime: 'application/pdf',
    kind: 'document',
    sizeBytes: 2048,
    sha256: 'b'.repeat(64)
  }
} satisfies Extract<Event, { type: 'assistant_attachment' }>

function conversation(id: string, events: Event[]): Convo {
  return {
    id,
    projectPath: null,
    projectLabel: 'Hermes',
    title: 'Returned files',
    modelRef: null,
    permissionMode: 'accept-edits',
    effort: 'adaptive',
    thinking: true,
    webSearch: false,
    ursaMode: 'code',
    hermesMode: 'native',
    projectId: null,
    pinned: false,
    archived: false,
    updatedAt: 1,
    createdAt: 1,
    loaded: true,
    events,
    auxEvents: projectAuxEvents(events),
    runState: 'idle',
    environment: 'local',
    worktrees: []
  }
}

function seedAttachmentSelection(events: Event[] = [returnedAttachment]): void {
  useAppStore.setState({
    view: { kind: 'conversation', id: 'conv_123' },
    conversations: {
      conv_123: conversation('conv_123', events)
    },
    auxSelection: {
      kind: 'attachment',
      conversationId: 'conv_123',
      attachmentId: 'att_123'
    },
    auxPaneOpenTick: 0,
    auxPaneWidth: 560
  })
}

beforeEach(() => {
  attachmentPreviewRender.mockClear()
  preview.mockReset()
  preview.mockResolvedValue({ kind: 'text', text: 'Verified preview body' })
  save.mockReset()
  save.mockResolvedValue('cancelled')
  showToast.mockReset()
  browserSetBounds.mockClear()
  browserShow.mockClear()
  browserHide.mockClear()
  readFile.mockClear()
  loadArtifactComments.mockClear()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  ;(window as unknown as { bearcode: BearcodeApi }).bearcode = {
    attachments: { preview, save },
    browser: {
      setBounds: browserSetBounds,
      show: browserShow,
      hide: browserHide
    },
    shell: { readFile }
  } as unknown as BearcodeApi
  useAppStore.setState({ showToast, loadArtifactComments } as never)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useAppStore.setState({
    showToast: realShowToast,
    loadArtifactComments: realLoadArtifactComments
  } as never)
})

describe('ArtifactsPane attachment mode', () => {
  it('shows persisted filename, file badge, and verified size without artifact controls', async () => {
    seedAttachmentSelection()

    const { container } = render(<ArtifactsPane />)

    expect(screen.getByText('verified-report.pdf')).toBeInTheDocument()
    expect(screen.getByText('PDF')).toBeInTheDocument()
    expect(screen.getByText('1.5 KB')).toBeInTheDocument()
    expect(await screen.findByText('Mock attachment preview att_123')).toBeInTheDocument()
    expect(container.querySelector('.ap-rail')).toBeNull()
    expect(container.querySelector('.artifact-version-history')).toBeNull()
    expect(container.querySelector('.artifact-status')).toBeNull()
    expect(container.querySelector('.plan-feedback-box')).toBeNull()
    expect(container.querySelector('.plan-comment-list')).toBeNull()
  })

  it('uses the standard close control to clear attachment mode', () => {
    seedAttachmentSelection()
    render(<ArtifactsPane />)

    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }))

    expect(useAppStore.getState().auxSelection).toBeNull()
  })

  it('reports when selected-conversation event metadata is no longer available', () => {
    seedAttachmentSelection([])

    render(<ArtifactsPane />)

    expect(screen.getByText('Attachment is no longer available')).toBeInTheDocument()
    expect(preview).not.toHaveBeenCalled()
  })

  it('reopens from a persisted attachment event after transient state is rehydrated', async () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'conv_123' },
      conversations: {
        conv_123: conversation('conv_123', [returnedAttachment])
      },
      auxSelection: null,
      auxPaneOpenTick: 0
    })

    useAppStore.getState().openAttachmentPane('conv_123', 'att_123')
    render(<ArtifactsPane />)

    expect(screen.getByText('verified-report.pdf')).toBeInTheDocument()
    expect(await screen.findByText('Mock attachment preview att_123')).toBeInTheDocument()
  })

  it('routes Download through opaque conversation and attachment IDs', async () => {
    seedAttachmentSelection()
    render(<ArtifactsPane />)

    fireEvent.click(screen.getByRole('button', { name: 'Download…' }))

    await waitFor(() => expect(save).toHaveBeenCalledWith('conv_123', 'att_123'))
  })

  it('shows the existing success notification after a saved download', async () => {
    save.mockResolvedValueOnce('saved')
    seedAttachmentSelection()
    render(<ArtifactsPane />)

    fireEvent.click(screen.getByRole('button', { name: 'Download…' }))

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Attachment saved'))
  })

  it('keeps cancellation silent', async () => {
    save.mockResolvedValueOnce('cancelled')
    seedAttachmentSelection()
    render(<ArtifactsPane />)

    fireEvent.click(screen.getByRole('button', { name: 'Download…' }))

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(showToast).not.toHaveBeenCalled()
  })

  it('shows the existing error notification when saving rejects', async () => {
    save.mockRejectedValueOnce(new Error('disk full'))
    seedAttachmentSelection()
    render(<ArtifactsPane />)

    fireEvent.click(screen.getByRole('button', { name: 'Download…' }))

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Could not save attachment'))
  })

  it('disables repeated downloads while the selected attachment save is pending', async () => {
    let finishSave: ((result: 'cancelled') => void) | undefined
    save.mockReturnValueOnce(
      new Promise<'cancelled'>((resolve) => {
        finishSave = resolve
      })
    )
    seedAttachmentSelection()
    render(<ArtifactsPane />)
    const download = screen.getByRole('button', { name: 'Download…' })

    fireEvent.click(download)

    expect(download).toBeDisabled()
    fireEvent.click(download)
    expect(save).toHaveBeenCalledTimes(1)

    finishSave?.('cancelled')
    await waitFor(() => expect(download).not.toBeDisabled())
  })
})

describe('ArtifactsPane motion lifecycle', () => {
  it('leaves actual plan feedback textarea arrow keys outside rail navigation', () => {
    const plan = {
      type: 'artifact',
      id: 'event-plan',
      artifactId: 'plan-1',
      artifactType: 'plan',
      version: 1,
      title: 'Implementation plan',
      status: 'pending-review',
      body: '# Implementation plan'
    } satisfies Extract<Event, { type: 'artifact' }>
    const walkthrough = {
      type: 'artifact',
      id: 'event-walkthrough',
      artifactId: 'walkthrough-1',
      artifactType: 'walkthrough',
      version: 1,
      title: 'Walkthrough',
      status: 'pending-review',
      body: '# Walkthrough'
    } satisfies Extract<Event, { type: 'artifact' }>
    const pendingCall = {
      type: 'tool_call',
      id: 'call-plan',
      tool: 'submit_plan',
      input: { artifactId: 'plan-1' },
      approvalState: 'pending'
    } satisfies Extract<Event, { type: 'tool_call' }>
    useAppStore.setState({
      view: { kind: 'conversation', id: 'conv_123' },
      conversations: {
        conv_123: conversation('conv_123', [plan, walkthrough, pendingCall])
      },
      auxSelection: { kind: 'artifact', artifactId: 'plan-1' },
      auxPaneOpenTick: 0
    })
    render(<ArtifactsPane />)

    const selectedRailTab = screen
      .getAllByRole('tab', { name: /Implementation Plan v1|Walkthrough v1/ })
      .find((tab) => tab.getAttribute('aria-selected') === 'true')!
    fireEvent.keyDown(screen.getByPlaceholderText('Feedback for the agent…'), { key: 'ArrowRight' })

    expect(selectedRailTab).toHaveAttribute('aria-selected', 'true')
  })

  it('removes plan actions when submit_plan is re-emitted as approved', () => {
    const plan = {
      type: 'artifact',
      id: 'event-plan',
      artifactId: 'plan-1',
      artifactType: 'plan',
      version: 1,
      title: 'Implementation plan',
      status: 'pending-review',
      body: '# Implementation plan'
    } satisfies Extract<Event, { type: 'artifact' }>
    const pendingCall = {
      type: 'tool_call',
      id: 'call-plan',
      tool: 'submit_plan',
      input: { artifactId: 'plan-1' },
      approvalState: 'pending'
    } satisfies Extract<Event, { type: 'tool_call' }>
    useAppStore.setState({
      view: { kind: 'conversation', id: 'conv_123' },
      conversations: {
        conv_123: conversation('conv_123', [plan, pendingCall])
      },
      auxSelection: { kind: 'artifact', artifactId: 'plan-1' },
      auxPaneOpenTick: 0
    })
    render(<ArtifactsPane />)
    expect(screen.getByRole('button', { name: 'Proceed' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Review' })).toBeInTheDocument()

    act(() => {
      useAppStore.setState((state) => ({
        conversations: {
          ...state.conversations,
          conv_123: mergeConvoEvent(state.conversations.conv_123, {
            ...pendingCall,
            approvalState: 'approved'
          })
        }
      }))
    })

    expect(screen.queryByRole('button', { name: 'Proceed' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull()
  })

  it('resizes the persistent shell without rerendering a stable body', () => {
    seedAttachmentSelection([returnedAttachment, returnedAttachmentTwo])
    const { container } = render(<ArtifactsPane />)
    const shell = container.querySelector('.ap-panel') as HTMLElement

    expect(screen.getByText('Mock attachment preview att_123')).toBeInTheDocument()
    expect(attachmentPreviewRender).toHaveBeenCalledTimes(1)

    act(() => {
      useAppStore.getState().setAuxPaneWidth(512, { persist: false })
      useAppStore.getState().setAuxPaneWidth(576, { persist: false })
      useAppStore.getState().setAuxPaneWidth(640, { persist: false })
    })

    expect(container.querySelector('.ap-panel')).toBe(shell)
    expect(shell).toHaveStyle({ flexBasis: '640px' })
    expect(attachmentPreviewRender).toHaveBeenCalledTimes(1)

    act(() => {
      useAppStore.setState({
        auxSelection: {
          kind: 'attachment',
          conversationId: 'conv_123',
          attachmentId: 'att_456'
        },
        auxPaneOpenTick: 1
      })
    })

    expect(screen.getByText('Mock attachment preview att_456')).toBeInTheDocument()
    expect(attachmentPreviewRender).toHaveBeenCalledTimes(2)
  })

  it('preserves the panel shell when the selected target changes', () => {
    seedAttachmentSelection()
    const { container } = render(<ArtifactsPane />)
    const shell = container.querySelector('.ap-panel')

    act(() => {
      useAppStore.setState({
        auxSelection: { kind: 'file', path: '/workspace/src/index.ts', line: 12 },
        auxPaneOpenTick: 1
      })
    })

    expect(container.querySelector('.ap-panel')).toBe(shell)
    expect(screen.getByText('index.ts:12')).toBeInTheDocument()
  })

  it('keeps closing content mounted until the shell transform completes', () => {
    seedAttachmentSelection()
    const { container } = render(<ArtifactsPane />)
    const shell = container.querySelector('.ap-panel') as HTMLElement

    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }))
    expect(container.querySelector('.ap-panel')).toBe(shell)

    fireEvent.transitionEnd(shell, { propertyName: 'opacity' })
    expect(container.querySelector('.ap-panel')).toBe(shell)

    fireEvent.transitionEnd(shell, { propertyName: 'transform' })
    expect(container.querySelector('.ap-panel')).toBeNull()
  })

  it('ignores child transitions and stale exit completion after reopening', () => {
    seedAttachmentSelection()
    const { container } = render(<ArtifactsPane />)
    const shell = container.querySelector('.ap-panel') as HTMLElement
    const child = screen.getByRole('button', { name: 'Close panel' })

    fireEvent.click(child)
    fireEvent.transitionEnd(child, { propertyName: 'transform' })
    expect(container.querySelector('.ap-panel')).toBe(shell)

    act(() => {
      useAppStore.setState({
        auxSelection: {
          kind: 'attachment',
          conversationId: 'conv_123',
          attachmentId: 'att_123'
        },
        auxPaneOpenTick: 1
      })
    })
    fireEvent.transitionEnd(shell, { propertyName: 'transform' })

    expect(container.querySelector('.ap-panel')).toBe(shell)
    expect(shell).toHaveAttribute('data-state', 'open')
  })

  it('keeps native browser pixels hidden until an opening shell settles', () => {
    useAppStore.setState({
      auxSelection: { kind: 'browser', conversationId: 'conv_123' },
      auxPaneOpenTick: 0,
      auxPaneWidth: 560
    })
    const { container } = render(<ArtifactsPane />)
    const shell = container.querySelector('.ap-panel') as HTMLElement

    expect(browserSetBounds).toHaveBeenCalled()
    expect(browserShow).not.toHaveBeenCalled()

    fireEvent.transitionEnd(shell, { propertyName: 'transform' })

    expect(browserShow).toHaveBeenCalledTimes(1)
  })

  it('shows browser immediately when selected in an already-settled shell and hides on close', () => {
    seedAttachmentSelection()
    const { container } = render(<ArtifactsPane />)
    const shell = container.querySelector('.ap-panel') as HTMLElement
    fireEvent.transitionEnd(shell, { propertyName: 'transform' })

    act(() => {
      useAppStore.setState({
        auxSelection: { kind: 'browser', conversationId: 'conv_123' },
        auxPaneOpenTick: 1
      })
    })

    expect(container.querySelector('.ap-panel')).toBe(shell)
    expect(browserShow).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }))
    expect(browserHide).toHaveBeenCalled()
  })
})
