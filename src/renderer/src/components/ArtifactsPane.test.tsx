// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BearcodeApi, BrowserStatus, Event, FileDiff } from '@shared/types'
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
const browserStatus: BrowserStatus = {
  phase: 'ready',
  message: null,
  installed: true,
  connected: true,
  conversationId: 'conv_123',
  debuggingEnabled: true
}
const browserGetStatus = vi.fn<() => Promise<BrowserStatus>>()
const browserUnsubscribe = vi.fn()
const browserOnStatus = vi.fn<(listener: (status: BrowserStatus) => void) => () => void>()
const getDiff = vi.fn()
const revertDiff = vi.fn().mockResolvedValue(undefined)
const openDiff = vi.fn().mockResolvedValue(undefined)
const previewDiffFile = vi.fn().mockResolvedValue({ kind: 'text', text: '' })
const readFile = vi.fn(() => new Promise<string>(() => {}))
const realShowToast = useAppStore.getState().showToast
const realLoadArtifactComments = useAppStore.getState().loadArtifactComments
const loadArtifactComments = vi.fn(() => Promise.resolve())
let bearcodeBefore: PropertyDescriptor | undefined

class ResizeObserverStub {
  observe = vi.fn()
  disconnect = vi.fn()
}

function stubMutableMatchMedia(initialReduced = false): {
  setReduced: (reduced: boolean) => void
} {
  let reduced = initialReduced
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const query = '(prefers-reduced-motion: reduce)'
  const media = {
    get matches() {
      return reduced
    },
    media: query,
    addEventListener: vi.fn((type: string, listener: (event: MediaQueryListEvent) => void) => {
      if (type === 'change') listeners.add(listener)
    }),
    removeEventListener: vi.fn((type: string, listener: (event: MediaQueryListEvent) => void) => {
      if (type === 'change') listeners.delete(listener)
    })
  } as unknown as MediaQueryList

  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => media)
  )

  return {
    setReduced: (nextReduced) => {
      reduced = nextReduced
      const event = { matches: reduced, media: query } as MediaQueryListEvent
      for (const listener of listeners) listener(event)
    }
  }
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

const browserPlan = {
  type: 'artifact',
  id: 'event-plan-browser-transition',
  artifactId: 'plan-browser-transition',
  artifactType: 'plan',
  version: 1,
  title: 'Browser transition plan',
  status: 'pending-review',
  body: '# Browser transition plan'
} satisfies Extract<Event, { type: 'artifact' }>

const browserWalkthrough = {
  type: 'artifact',
  id: 'event-walkthrough-browser-transition',
  artifactId: 'walkthrough-browser-transition',
  artifactType: 'walkthrough',
  version: 1,
  title: 'Browser transition walkthrough',
  status: 'final',
  body: '# Browser transition walkthrough'
} satisfies Extract<Event, { type: 'artifact' }>

const browserDiff: FileDiff = {
  diffId: 'diff-browser-transition',
  files: [
    {
      fileId: 'file-browser-transition',
      path: '/workspace/src/browser-transition.ts',
      status: 'modified',
      beforeText: 'export const transition = false\n',
      afterText: 'export const transition = true\n',
      additions: 1,
      deletions: 1,
      state: 'applied'
    }
  ]
}

const browserDiffEvent = {
  type: 'file_diff',
  id: 'event-diff-browser-transition',
  diffId: browserDiff.diffId,
  files: browserDiff.files.map(({ path, additions, deletions, status }) => ({
    path,
    additions,
    deletions,
    status
  }))
} satisfies Extract<Event, { type: 'file_diff' }>

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  return {
    promise: new Promise<T>((finish, fail) => {
      resolve = finish
      reject = fail
    }),
    resolve,
    reject
  }
}

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

function seedBrowserSelection(events: Event[]): void {
  useAppStore.setState({
    view: { kind: 'conversation', id: 'conv_123' },
    conversations: {
      conv_123: conversation('conv_123', events)
    },
    auxSelection: { kind: 'browser', conversationId: 'conv_123' },
    auxPaneOpenTick: 0,
    auxPaneWidth: 560,
    reviewFocusPath: null
  })
}

beforeEach(() => {
  bearcodeBefore = Object.getOwnPropertyDescriptor(window, 'bearcode')
  attachmentPreviewRender.mockClear()
  preview.mockReset()
  preview.mockResolvedValue({ kind: 'text', text: 'Verified preview body' })
  save.mockReset()
  save.mockResolvedValue('cancelled')
  showToast.mockReset()
  browserSetBounds.mockClear()
  browserShow.mockClear()
  browserHide.mockReset()
  browserHide.mockResolvedValue(undefined)
  browserGetStatus.mockReset()
  browserGetStatus.mockResolvedValue(browserStatus)
  browserUnsubscribe.mockClear()
  browserOnStatus.mockReset()
  browserOnStatus.mockImplementation((listener) => {
    listener(browserStatus)
    return browserUnsubscribe
  })
  getDiff.mockReset()
  getDiff.mockResolvedValue(browserDiff)
  revertDiff.mockClear()
  openDiff.mockClear()
  previewDiffFile.mockClear()
  readFile.mockClear()
  loadArtifactComments.mockClear()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  // jsdom rects are all-zero, which BrowserPane now correctly skips as a
  // degenerate measurement; give elements a realistic in-window rect so the
  // motion-lifecycle tests still see bounds pushes.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600))
  ;(window as unknown as { bearcode: BearcodeApi }).bearcode = {
    attachments: { preview, save },
    browser: {
      status: browserGetStatus,
      onStatus: browserOnStatus,
      setBounds: browserSetBounds,
      show: browserShow,
      hide: browserHide
    },
    diffs: {
      get: getDiff,
      revert: revertDiff,
      open: openDiff,
      previewFile: previewDiffFile
    },
    shell: { readFile }
  } as unknown as BearcodeApi
  useAppStore.setState({ showToast, loadArtifactComments } as never)
})

afterEach(() => {
  cleanup()
  if (bearcodeBefore) Object.defineProperty(window, 'bearcode', bearcodeBefore)
  else Reflect.deleteProperty(window, 'bearcode')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.documentElement.removeAttribute('data-motion')
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
  it('labels a single artifact as a direct region when no artifact rail is rendered', () => {
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
    useAppStore.setState({
      view: { kind: 'conversation', id: 'conv_123' },
      conversations: {
        conv_123: conversation('conv_123', [plan])
      },
      auxSelection: { kind: 'artifact', artifactId: 'plan-1' },
      auxPaneOpenTick: 0
    })
    render(<ArtifactsPane />)

    expect(screen.queryByRole('tablist', { name: 'Artifacts' })).toBeNull()
    const content = screen.getByRole('region', { name: 'Artifact content' })
    expect(content).not.toHaveAttribute('id', 'artifacts-rail-content')
    expect(content).not.toHaveAttribute('aria-labelledby')
    expect(document.getElementById('artifacts-rail-tab-artifact:plan-1')).toBeNull()
    expect(document.querySelector('[aria-labelledby]')).toBeNull()
  })

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

  it('keeps native browser pixels hidden until an opening shell settles', async () => {
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

    await waitFor(() => expect(browserShow).toHaveBeenCalledTimes(1))
  })

  it('settles an opening native browser when OS reduced motion turns on', async () => {
    const media = stubMutableMatchMedia()
    useAppStore.setState({
      auxSelection: { kind: 'browser', conversationId: 'conv_123' },
      auxPaneOpenTick: 0,
      auxPaneWidth: 560
    })
    render(<ArtifactsPane />)

    expect(browserSetBounds).toHaveBeenCalled()
    expect(browserShow).not.toHaveBeenCalled()

    act(() => media.setReduced(true))

    await waitFor(() => expect(browserShow).toHaveBeenCalledTimes(1))
  })

  it('ignores a panel transition cancellation while normal motion remains active', () => {
    stubMutableMatchMedia()
    seedAttachmentSelection()
    const { container } = render(<ArtifactsPane />)
    const shell = container.querySelector('.ap-panel') as HTMLElement

    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }))
    fireEvent.transitionCancel(shell, { propertyName: 'transform' })

    expect(container.querySelector('.ap-panel')).toBe(shell)
    expect(shell).toHaveAttribute('data-state', 'closing')
  })

  it('shows browser immediately when selected in an already-settled shell and hides on close', async () => {
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
    await waitFor(() => expect(browserShow).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }))
    expect(browserHide).toHaveBeenCalled()
  })

  it('retains browser content until authoritative hide resolves before showing an artifact', async () => {
    seedBrowserSelection([browserPlan])
    const { container } = render(<ArtifactsPane />)
    const shell = container.querySelector('.ap-panel') as HTMLElement
    fireEvent.transitionEnd(shell, { propertyName: 'transform' })
    await waitFor(() => expect(browserShow).toHaveBeenCalledTimes(1))
    const departureHide = deferred<void>()
    browserHide.mockReturnValueOnce(departureHide.promise)

    act(() => {
      useAppStore.setState((state) => ({
        auxSelection: { kind: 'artifact', artifactId: browserPlan.artifactId },
        auxPaneOpenTick: state.auxPaneOpenTick + 1
      }))
    })

    expect(container.querySelector('.ap-panel')).toHaveAttribute('data-panel-kind', 'browser')
    expect(container.querySelector('.browser-pane')).toBeInTheDocument()
    expect(screen.queryByText(browserPlan.title)).toBeNull()

    await act(async () => departureHide.resolve(undefined))

    await waitFor(() =>
      expect(container.querySelector('.ap-panel')).toHaveAttribute('data-panel-kind', 'artifact')
    )
    expect(screen.getAllByText(browserPlan.title)).not.toHaveLength(0)
  })

  it('retains browser content until authoritative hide resolves before showing a diff', async () => {
    seedBrowserSelection([browserDiffEvent])
    const { container } = render(<ArtifactsPane />)
    const shell = container.querySelector('.ap-panel') as HTMLElement
    fireEvent.transitionEnd(shell, { propertyName: 'transform' })
    await waitFor(() => expect(browserShow).toHaveBeenCalledTimes(1))
    const departureHide = deferred<void>()
    browserHide.mockReturnValueOnce(departureHide.promise)

    act(() => {
      useAppStore.setState((state) => ({
        auxSelection: { kind: 'diff', diffId: browserDiff.diffId },
        auxPaneOpenTick: state.auxPaneOpenTick + 1
      }))
    })

    expect(container.querySelector('.ap-panel')).toHaveAttribute('data-panel-kind', 'browser')
    expect(screen.queryByRole('tablist', { name: 'Review mode' })).toBeNull()

    await act(async () => departureHide.resolve(undefined))

    expect(await screen.findByRole('tablist', { name: 'Review mode' })).toBeInTheDocument()
    expect(container.querySelector('.ap-panel')).toHaveAttribute('data-panel-kind', 'diff')
  })

  it('commits only the latest rapid browser retarget after one pending hide settles', async () => {
    seedBrowserSelection([browserPlan, browserWalkthrough])
    const { container } = render(<ArtifactsPane />)
    const shell = container.querySelector('.ap-panel') as HTMLElement
    fireEvent.transitionEnd(shell, { propertyName: 'transform' })
    await waitFor(() => expect(browserShow).toHaveBeenCalledTimes(1))
    const departureHide = deferred<void>()
    browserHide.mockReturnValueOnce(departureHide.promise)

    act(() => {
      useAppStore.setState((state) => ({
        auxSelection: { kind: 'artifact', artifactId: browserPlan.artifactId },
        auxPaneOpenTick: state.auxPaneOpenTick + 1
      }))
      useAppStore.setState((state) => ({
        auxSelection: { kind: 'artifact', artifactId: browserWalkthrough.artifactId },
        auxPaneOpenTick: state.auxPaneOpenTick + 1
      }))
    })

    expect(container.querySelector('.ap-panel')).toHaveAttribute('data-panel-kind', 'browser')
    await act(async () => departureHide.resolve(undefined))

    expect(await screen.findAllByText(browserWalkthrough.title)).not.toHaveLength(0)
    expect(screen.queryAllByText(browserPlan.title)).toHaveLength(0)
  })

  it('does not commit a stale browser replacement after the pane closes during hide', async () => {
    seedBrowserSelection([browserPlan])
    const { container } = render(<ArtifactsPane />)
    const shell = container.querySelector('.ap-panel') as HTMLElement
    fireEvent.transitionEnd(shell, { propertyName: 'transform' })
    await waitFor(() => expect(browserShow).toHaveBeenCalledTimes(1))
    const departureHide = deferred<void>()
    browserHide.mockReturnValueOnce(departureHide.promise)

    act(() => {
      useAppStore.setState((state) => ({
        auxSelection: { kind: 'artifact', artifactId: browserPlan.artifactId },
        auxPaneOpenTick: state.auxPaneOpenTick + 1
      }))
      useAppStore.getState().closeReview()
    })

    expect(shell).toHaveAttribute('data-state', 'closing')
    await act(async () => departureHide.resolve(undefined))
    expect(screen.queryByText(browserPlan.title)).toBeNull()
    expect(container.querySelector('.ap-panel')).toHaveAttribute('data-panel-kind', 'browser')

    fireEvent.transitionEnd(shell, { propertyName: 'transform' })
    expect(container.querySelector('.ap-panel')).toBeNull()
  })
})
