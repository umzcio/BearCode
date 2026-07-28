// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BearcodeApi,
  ConversationMeta,
  PickedAttachmentWire,
  ProviderModels
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
const pickAttachments = vi.fn(async () => ({
  picked: [pickedAttachment],
  errors: []
}))

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
  vi.clearAllMocks()
})

describe('Home accepted draft handoff', () => {
  it('remounts the accepted conversation with late text and the literal attachment', async () => {
    const pendingRun = deferred<void>()
    runStart.mockReturnValueOnce(pendingRun.promise)
    render(<MainViewHarness />)

    const homeTextbox = screen.getByRole('textbox')
    fireEvent.change(homeTextbox, { target: { value: 'submitted' } })
    fireEvent.click(screen.getByLabelText('Send'))
    await waitFor(() => expect(runStart).toHaveBeenCalledOnce())

    fireEvent.change(homeTextbox, { target: { value: 'late text' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    fireEvent.click(screen.getByRole('option', { name: /^Media/ }))
    await screen.findByText('late.png')

    await act(async () => pendingRun.resolve(undefined))

    await waitFor(() =>
      expect(useAppStore.getState().view).toEqual({ kind: 'conversation', id: 'c1' })
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
    fireEvent.change(homeTextbox, { target: { value: 'latest before leaving' } })

    act(() => useAppStore.setState({ view: { kind: 'models' } }))
    expect(screen.getByText('Different view')).toBeInTheDocument()

    await act(async () => pendingRun.resolve(undefined))

    await waitFor(() =>
      expect(useAppStore.getState().view).toEqual({ kind: 'conversation', id: 'c1' })
    )
    expect(screen.getByRole('textbox')).toHaveValue('latest before leaving')
    expect(useAppStore.getState().acceptedHomeConvoId).toBeNull()
    await waitFor(() => expect(useAppStore.getState().conversationDraftHandoff).toBeNull())
  })
})
