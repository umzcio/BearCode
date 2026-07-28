// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BearcodeApi,
  ConversationMeta,
  PickedAttachmentWire,
  ProviderModels,
  TranscribeMeta
} from '@shared/types'
import { useAppStore } from '../state/store'
import { Composer } from './Composer/Composer'
import { Home } from './Home'

const pickedAttachment: PickedAttachmentWire = {
  ref: {
    id: 'attachment-late',
    name: 'late.png',
    mime: 'image/png',
    kind: 'image'
  },
  previewDataUrl: 'data:image/png;base64,bGF0ZQ=='
}

const provider: ProviderModels = {
  id: 'anthropic',
  displayName: 'Anthropic',
  color: '#c98a4b',
  requiresKey: true,
  keyConfigured: true,
  reachable: true,
  models: [{ id: 'claude-sonnet-5', label: 'Claude Sonnet 5' }]
}

const conversationMeta: ConversationMeta = {
  id: 'c1',
  projectPath: null,
  title: null,
  modelRef: null,
  createdAt: 1,
  updatedAt: 1,
  permissionMode: 'accept-edits',
  activeRules: [],
  effort: 'adaptive',
  thinking: true,
  webSearch: false,
  ursaMode: 'code',
  hermesSessionId: null,
  hermesMode: 'legacy',
  projectId: null,
  pinned: false,
  archived: false,
  environment: 'local',
  worktrees: []
}

const runStart = vi.fn()
const createConversation = vi.fn(
  async (_projectPath: string | null, id?: string): Promise<ConversationMeta> => ({
    ...conversationMeta,
    id: id ?? conversationMeta.id
  })
)
const pickAttachments = vi.fn(
  async (): Promise<{ picked: PickedAttachmentWire[]; errors: string[] }> => ({
    picked: [pickedAttachment],
    errors: []
  })
)
const getUserMedia = vi.fn(
  async () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream
)
const transcribe = vi.fn<(audio: ArrayBuffer, meta: TranscribeMeta) => Promise<{ text: string }>>(
  async () => ({ text: ' voice transcript' })
)

class MockMediaRecorder {
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  mimeType = 'audio/webm'
  state = 'inactive'

  constructor(public stream: MediaStream) {}

  start(): void {
    this.state = 'recording'
  }

  stop(): void {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['voice'], { type: 'audio/webm' }) })
    this.onstop?.()
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function MainViewHarness(): React.JSX.Element {
  const view = useAppStore((state) => state.view)
  const handoff = useAppStore((state) => state.conversationDraftHandoff)
  const consume = useAppStore((state) => state.consumeConversationDraftHandoff)

  if (view.kind === 'home') return <Home />
  if (view.kind !== 'conversation') return <div>Different view</div>

  return (
    <Composer
      conversationId={view.id}
      initialDraft={handoff?.conversationId === view.id ? handoff.draft : undefined}
      onInitialDraftConsumed={() => consume(view.id)}
      onSend={async () => true}
    />
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  runStart.mockResolvedValue(undefined)
  vi.stubGlobal('MediaRecorder', MockMediaRecorder as unknown as typeof MediaRecorder)
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia }
  })
  ;(window as unknown as { matchMedia: (query: string) => MediaQueryList }).matchMedia = vi.fn(
    (query: string) =>
      ({
        matches: true,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn()
      }) as MediaQueryList
  )
  ;(window as unknown as { bearcode: BearcodeApi }).bearcode = {
    conversations: {
      create: createConversation,
      setMode: vi.fn(async () => undefined),
      setEffort: vi.fn(async () => undefined),
      setThinking: vi.fn(async () => undefined),
      setWebSearch: vi.fn(async () => undefined),
      setUrsaMode: vi.fn(async () => undefined)
    },
    run: {
      start: runStart
    },
    attachments: {
      pick: pickAttachments,
      read: vi.fn(async () => null)
    },
    voice: {
      transcribe
    }
  } as unknown as BearcodeApi
  useAppStore.setState({
    view: { kind: 'home' },
    providers: [provider],
    modelRef: 'anthropic/claude-sonnet-5',
    workspacePath: null,
    conversations: {},
    convoOrder: [],
    draftConvoId: null,
    pendingHomeConvoId: null,
    pendingHomeAttempt: null,
    acceptedHomeConvoId: null,
    conversationDraftHandoff: null,
    composerEnvironment: 'local',
    permissionMode: 'accept-edits',
    effort: 'adaptive',
    thinking: true,
    webSearch: false,
    ursaMode: 'code',
    commands: [],
    resumePickerOpen: false,
    fileSuggestions: [],
    manualRules: [],
    mcpConnectors: [],
    manualSkills: []
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('Home accepted draft handoff', () => {
  it('hands off a voice transcript that settles after Home unmounts', async () => {
    const pendingRun = deferred<void>()
    const pendingTranscript = deferred<{ text: string }>()
    runStart.mockReturnValueOnce(pendingRun.promise)
    transcribe.mockReturnValueOnce(pendingTranscript.promise)
    const observedHandoffs: NonNullable<
      ReturnType<typeof useAppStore.getState>['conversationDraftHandoff']
    >[] = []
    const unsubscribe = useAppStore.subscribe((state) => {
      if (state.conversationDraftHandoff) observedHandoffs.push(state.conversationDraftHandoff)
    })

    try {
      render(<MainViewHarness />)
      const homeTextbox = screen.getByRole('textbox')
      fireEvent.change(homeTextbox, { target: { value: 'submitted' } })
      fireEvent.click(screen.getByLabelText('Voice input (⌃M)'))
      await screen.findByLabelText('Stop recording (⌃M)')
      fireEvent.click(screen.getByLabelText('Stop recording (⌃M)'))
      await waitFor(() => expect(transcribe).toHaveBeenCalledOnce())

      fireEvent.click(screen.getByLabelText('Send'))
      await waitFor(() => expect(runStart).toHaveBeenCalledOnce())
      const acceptedId = useAppStore.getState().draftConvoId
      expect(acceptedId).toEqual(expect.any(String))

      act(() => useAppStore.setState({ view: { kind: 'models' } }))
      expect(screen.getByText('Different view')).toBeInTheDocument()

      await act(async () => pendingRun.resolve(undefined))
      await waitFor(() => expect(useAppStore.getState().acceptedHomeConvoId).toBe(acceptedId))
      expect(useAppStore.getState().view).toEqual({ kind: 'models' })
      expect(useAppStore.getState().conversationDraftHandoff).toBeNull()

      await act(async () => pendingTranscript.resolve({ text: ' voice transcript' }))

      await waitFor(() =>
        expect(useAppStore.getState().view).toEqual({ kind: 'conversation', id: acceptedId })
      )
      expect(screen.getByRole('textbox')).toHaveValue('submitted voice transcript')
      expect(observedHandoffs).toEqual([
        {
          conversationId: acceptedId,
          draft: {
            text: 'submitted voice transcript',
            command: null,
            mentions: [],
            attachments: []
          }
        }
      ])
      await waitFor(() => expect(useAppStore.getState().conversationDraftHandoff).toBeNull())

      act(() => useAppStore.setState({ view: { kind: 'models' } }))
      act(() =>
        useAppStore.setState({
          view: { kind: 'conversation', id: acceptedId! }
        })
      )
      expect(screen.getByRole('textbox')).toHaveValue('')
    } finally {
      unsubscribe()
    }
  })

  it('keeps Home ownership pending until a deferred Media pick joins the accepted transfer', async () => {
    const pendingRun = deferred<void>()
    const pendingPick = deferred<{ picked: PickedAttachmentWire[]; errors: string[] }>()
    runStart.mockReturnValueOnce(pendingRun.promise)
    pickAttachments.mockReturnValueOnce(pendingPick.promise)
    render(<MainViewHarness />)

    const homeTextbox = screen.getByRole('textbox')
    fireEvent.change(homeTextbox, { target: { value: 'submitted' } })
    fireEvent.click(screen.getByLabelText('Send'))
    await waitFor(() => expect(runStart).toHaveBeenCalledOnce())
    const acceptedId = useAppStore.getState().draftConvoId
    expect(acceptedId).toEqual(expect.any(String))

    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    fireEvent.click(screen.getByRole('option', { name: /^Media/ }))
    expect(pickAttachments).toHaveBeenCalledWith(acceptedId, 0)

    await act(async () => pendingRun.resolve(undefined))
    await waitFor(() => expect(useAppStore.getState().acceptedHomeConvoId).toBe(acceptedId))
    expect(useAppStore.getState()).toMatchObject({
      view: { kind: 'home' },
      pendingHomeConvoId: acceptedId,
      acceptedHomeConvoId: acceptedId,
      conversationDraftHandoff: null
    })
    expect(screen.getByRole('textbox')).toBe(homeTextbox)

    await act(async () =>
      pendingPick.resolve({
        picked: [pickedAttachment],
        errors: []
      })
    )

    await waitFor(() =>
      expect(useAppStore.getState().view).toEqual({ kind: 'conversation', id: acceptedId })
    )
    expect(screen.getByAltText('late.png')).toHaveAttribute('src', pickedAttachment.previewDataUrl)
    await waitFor(() => expect(useAppStore.getState().conversationDraftHandoff).toBeNull())
  })

  it('keeps a late attachment under the id reserved before deferred conversation creation', async () => {
    const pendingCreate = deferred<ConversationMeta>()
    const pendingRun = deferred<void>()
    createConversation.mockReturnValueOnce(pendingCreate.promise)
    runStart.mockReturnValueOnce(pendingRun.promise)
    const observedHandoffs: NonNullable<
      ReturnType<typeof useAppStore.getState>['conversationDraftHandoff']
    >[] = []
    const unsubscribe = useAppStore.subscribe((state) => {
      if (state.conversationDraftHandoff) observedHandoffs.push(state.conversationDraftHandoff)
    })

    try {
      render(<MainViewHarness />)

      const homeTextbox = screen.getByRole('textbox')
      fireEvent.change(homeTextbox, { target: { value: 'submitted' } })
      fireEvent.click(screen.getByLabelText('Send'))
      await waitFor(() => expect(createConversation).toHaveBeenCalledOnce())

      const reservedId = useAppStore.getState().draftConvoId
      expect(reservedId).toEqual(expect.any(String))
      expect(createConversation).toHaveBeenCalledWith(null, reservedId)

      act(() => useAppStore.getState().goHome())
      expect(screen.getByRole('textbox')).toBe(homeTextbox)
      expect(useAppStore.getState().draftConvoId).toBe(reservedId)

      fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
      fireEvent.click(screen.getByRole('option', { name: /^Media/ }))
      await screen.findByText('late.png')
      expect(pickAttachments).toHaveBeenCalledWith(reservedId, 0)

      await act(async () => pendingCreate.resolve({ ...conversationMeta, id: reservedId! }))
      await waitFor(() => expect(runStart).toHaveBeenCalledOnce())
      expect(runStart).toHaveBeenCalledWith(
        reservedId,
        'submitted',
        'anthropic/claude-sonnet-5',
        null,
        null,
        [],
        []
      )

      await act(async () => pendingRun.resolve(undefined))

      await waitFor(() =>
        expect(useAppStore.getState().view).toEqual({
          kind: 'conversation',
          id: reservedId
        })
      )
      expect(observedHandoffs).toEqual([
        {
          conversationId: reservedId,
          draft: {
            text: '',
            command: null,
            mentions: [],
            attachments: [pickedAttachment]
          }
        }
      ])
      expect(screen.getByAltText('late.png')).toHaveAttribute(
        'src',
        pickedAttachment.previewDataUrl
      )
      await waitFor(() => expect(useAppStore.getState().conversationDraftHandoff).toBeNull())
    } finally {
      unsubscribe()
    }
  })

  it('remounts the accepted conversation with late text and the literal attachment', async () => {
    const pendingRun = deferred<void>()
    runStart.mockReturnValueOnce(pendingRun.promise)
    render(<MainViewHarness />)

    const homeTextbox = screen.getByRole('textbox')
    fireEvent.change(homeTextbox, { target: { value: 'submitted' } })
    fireEvent.click(screen.getByLabelText('Send'))
    await waitFor(() => expect(runStart).toHaveBeenCalledOnce())
    const acceptedId = useAppStore.getState().draftConvoId
    expect(acceptedId).toEqual(expect.any(String))

    fireEvent.change(homeTextbox, { target: { value: 'late text' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    fireEvent.click(screen.getByRole('option', { name: /^Media/ }))
    await screen.findByText('late.png')

    await act(async () => pendingRun.resolve(undefined))

    await waitFor(() =>
      expect(useAppStore.getState().view).toEqual({ kind: 'conversation', id: acceptedId })
    )
    expect(screen.getByRole('textbox')).toHaveValue('late text')
    expect(screen.getByAltText('late.png')).toHaveAttribute('src', pickedAttachment.previewDataUrl)
    expect(screen.queryByDisplayValue('submitted')).toBeNull()
    await waitFor(() => expect(useAppStore.getState().conversationDraftHandoff).toBeNull())
  })

  it('opens the accepted conversation with the latest draft after Home unmounts mid-start', async () => {
    const pendingRun = deferred<void>()
    runStart.mockReturnValueOnce(pendingRun.promise)
    render(<MainViewHarness />)

    const homeTextbox = screen.getByRole('textbox')
    fireEvent.change(homeTextbox, { target: { value: 'submitted' } })
    fireEvent.click(screen.getByLabelText('Send'))
    await waitFor(() => expect(runStart).toHaveBeenCalledOnce())
    const acceptedId = useAppStore.getState().draftConvoId
    expect(acceptedId).toEqual(expect.any(String))
    fireEvent.change(homeTextbox, { target: { value: 'latest before leaving' } })

    act(() => useAppStore.setState({ view: { kind: 'models' } }))
    expect(screen.getByText('Different view')).toBeInTheDocument()

    await act(async () => pendingRun.resolve(undefined))

    await waitFor(() =>
      expect(useAppStore.getState().view).toEqual({ kind: 'conversation', id: acceptedId })
    )
    expect(screen.getByRole('textbox')).toHaveValue('latest before leaving')
    expect(useAppStore.getState().acceptedHomeConvoId).toBeNull()
    await waitFor(() => expect(useAppStore.getState().conversationDraftHandoff).toBeNull())
  })

  it('claims the handoff when the accepted conversation Composer is already mounted', async () => {
    const pendingRun = deferred<void>()
    runStart.mockReturnValueOnce(pendingRun.promise)
    render(<MainViewHarness />)

    const homeTextbox = screen.getByRole('textbox')
    fireEvent.change(homeTextbox, { target: { value: 'submitted' } })
    fireEvent.click(screen.getByLabelText('Send'))
    await waitFor(() => expect(runStart).toHaveBeenCalledOnce())
    const acceptedId = useAppStore.getState().draftConvoId
    expect(acceptedId).toEqual(expect.any(String))

    fireEvent.change(homeTextbox, { target: { value: 'late text' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    fireEvent.click(screen.getByRole('option', { name: /^Media/ }))
    await screen.findByText('late.png')

    act(() => useAppStore.setState({ view: { kind: 'conversation', id: acceptedId! } }))
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(useAppStore.getState().conversationDraftHandoff).toBeNull()

    await act(async () => pendingRun.resolve(undefined))

    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('late text'))
    expect(screen.getByAltText('late.png')).toHaveAttribute('src', pickedAttachment.previewDataUrl)
    expect(useAppStore.getState().conversationDraftHandoff).toBeNull()
  })
})
