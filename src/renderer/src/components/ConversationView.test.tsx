// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { StrictMode } from 'react'
import type { BearcodeApi } from '@shared/types'
import { useAppStore } from '../state/store'
import { ConversationView } from './ConversationView'

beforeEach(() => {
  ;(window as unknown as { bearcode: BearcodeApi }).bearcode = {
    attachments: {
      pick: vi.fn(async () => ({ picked: [], errors: [] })),
      read: vi.fn(async () => null)
    }
  } as unknown as BearcodeApi
  useAppStore.setState({ conversationDraftHandoff: null })
})
afterEach(cleanup)

describe('ConversationView accepted Home draft handoff', () => {
  const conversation = {
    id: 'c1',
    projectPath: '/p',
    title: 'T',
    modelRef: 'anthropic/claude-sonnet-5',
    permissionMode: 'accept-edits',
    updatedAt: 1,
    createdAt: 1,
    loaded: true,
    runState: 'idle',
    events: [],
    environment: 'local',
    effort: 'adaptive',
    thinking: true,
    webSearch: false,
    ursaMode: 'code',
    hermesMode: 'legacy',
    projectId: null,
    pinned: false,
    archived: false,
    worktrees: []
  }
  const draft = {
    text: 'late text',
    command: null,
    mentions: [],
    attachments: [
      {
        ref: {
          id: 'attachment-late',
          name: 'late.png',
          mime: 'image/png',
          kind: 'image'
        },
        previewDataUrl: 'data:image/png;base64,bGF0ZQ=='
      }
    ]
  } as const

  it('claims a matching handoff once under StrictMode and does not restore it on reopen', async () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      modelRef: 'anthropic/claude-sonnet-5',
      providers: [
        {
          id: 'anthropic',
          displayName: 'Anthropic',
          color: '#c98a4b',
          requiresKey: true,
          keyConfigured: true,
          reachable: true,
          models: [{ id: 'claude-sonnet-5', label: 'Claude Sonnet 5' }]
        }
      ],
      conversations: { c1: conversation },
      convoOrder: ['c1'],
      focusEventId: null,
      focusMatches: [],
      conversationDraftHandoff: {
        conversationId: 'c1',
        draft
      }
    } as never)

    const mounted = render(
      <StrictMode>
        <ConversationView convoId="c1" />
      </StrictMode>
    )

    expect(screen.getByRole('textbox')).toHaveValue('late text')
    expect(screen.getByText('late.png')).toBeInTheDocument()
    await waitFor(() => expect(useAppStore.getState().conversationDraftHandoff).toBeNull())

    mounted.unmount()
    render(
      <StrictMode>
        <ConversationView convoId="c1" />
      </StrictMode>
    )

    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(screen.queryByText('late.png')).toBeNull()
  })

  it('neither renders nor consumes a handoff for a different conversation', () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      modelRef: 'anthropic/claude-sonnet-5',
      providers: [],
      conversations: { c1: conversation },
      convoOrder: ['c1'],
      focusEventId: null,
      focusMatches: [],
      conversationDraftHandoff: {
        conversationId: 'c2',
        draft
      }
    } as never)

    render(<ConversationView convoId="c1" />)

    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(screen.queryByText('late.png')).toBeNull()
    expect(useAppStore.getState().conversationDraftHandoff).toEqual({
      conversationId: 'c2',
      draft
    })
  })
})

describe('ConversationView user bubble', () => {
  it('renders a mention pill for each persisted user_message mention', () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      modelRef: 'anthropic/claude-sonnet-5',
      providers: [],
      conversations: {
        c1: {
          id: 'c1',
          projectPath: '/p',
          title: 'T',
          modelRef: 'anthropic/claude-sonnet-5',
          permissionMode: 'accept-edits',
          updatedAt: 1,
          loaded: true,
          runState: 'idle',
          events: [
            {
              type: 'user_message',
              id: 'u1',
              text: 'look here',
              mentions: [{ kind: 'file', name: 'src/a.ts', path: 'src/a.ts' }]
            }
          ]
        }
      },
      convoOrder: ['c1']
    } as never)
    render(<ConversationView convoId="c1" />)
    expect(screen.getByText('@src/a.ts')).toBeTruthy()
    expect(screen.getByText('look here')).toBeTruthy()
  })

  it('renders attachment pills on a user message and fetches the real thumbnail', async () => {
    const read = vi.fn(async () => 'data:image/png;base64,AAAA')
    ;(window as unknown as { bearcode: BearcodeApi }).bearcode = {
      attachments: { pick: vi.fn(async () => ({ picked: [], errors: [] })), read }
    } as unknown as BearcodeApi
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      modelRef: 'anthropic/claude-sonnet-5',
      providers: [],
      conversations: {
        c1: {
          id: 'c1',
          projectPath: '/p',
          title: 'T',
          modelRef: 'anthropic/claude-sonnet-5',
          permissionMode: 'accept-edits',
          updatedAt: 1,
          loaded: true,
          runState: 'idle',
          events: [
            {
              type: 'user_message',
              id: 'u1',
              text: 'describe',
              attachments: [{ id: 'a1', name: 'shot.png', mime: 'image/png' }]
            }
          ]
        }
      },
      convoOrder: ['c1']
    } as never)
    render(<ConversationView convoId="c1" />)
    expect(screen.getByText('shot.png')).toBeTruthy()
    expect(read).toHaveBeenCalledWith('c1', 'a1')
    await waitFor(() => {
      const img = screen.getByAltText('shot.png') as HTMLImageElement
      expect(img.src).toBe('data:image/png;base64,AAAA')
    })
  })
})

describe('ConversationView compaction marker', () => {
  const baseConvo = {
    id: 'c1',
    projectPath: '/p',
    title: 'T',
    modelRef: 'anthropic/claude-sonnet-5',
    permissionMode: 'accept-edits',
    updatedAt: 1,
    loaded: true,
    runState: 'idle'
  }

  it('renders the marker when the stream carries a compaction event', () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      modelRef: 'anthropic/claude-sonnet-5',
      providers: [],
      conversations: {
        c1: {
          ...baseConvo,
          events: [
            { type: 'user_message', id: 'u1', text: 'hello' },
            { type: 'compaction', id: 'k1', summarizedCount: 12 }
          ]
        }
      },
      convoOrder: ['c1']
    } as never)
    render(<ConversationView convoId="c1" />)
    expect(screen.getByText('Compacted 12 earlier messages')).toBeTruthy()
  })

  it('singularizes the label for a single summarized message', () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      modelRef: 'anthropic/claude-sonnet-5',
      providers: [],
      conversations: {
        c1: {
          ...baseConvo,
          events: [{ type: 'compaction', id: 'k1', summarizedCount: 1 }]
        }
      },
      convoOrder: ['c1']
    } as never)
    render(<ConversationView convoId="c1" />)
    expect(screen.getByText('Compacted 1 earlier message')).toBeTruthy()
  })

  it('renders nothing compaction-related when no compaction event is present', () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      modelRef: 'anthropic/claude-sonnet-5',
      providers: [],
      conversations: {
        c1: {
          ...baseConvo,
          events: [{ type: 'user_message', id: 'u1', text: 'hello' }]
        }
      },
      convoOrder: ['c1']
    } as never)
    const { container } = render(<ConversationView convoId="c1" />)
    expect(screen.queryByText(/Compacted .* earlier message/)).toBeNull()
    expect(container.querySelector('.compaction-marker')).toBeNull()
  })
})

// Task 11: Ursa role/model hover badge on assistant turns routed through Ursa.
describe('ConversationView Ursa badge', () => {
  it('shows a role/model badge on hover for a turn that ran under Ursa', () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      modelRef: 'ursa/auto',
      providers: [
        {
          id: 'anthropic',
          displayName: 'Anthropic',
          color: '#c98a4b',
          requiresKey: true,
          keyConfigured: true,
          reachable: true,
          models: [{ id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' }]
        }
      ],
      conversations: {
        c1: {
          id: 'c1',
          projectPath: '/p',
          title: 'T',
          modelRef: 'ursa/auto',
          permissionMode: 'accept-edits',
          updatedAt: 1,
          loaded: true,
          runState: 'idle',
          events: [
            { type: 'user_message', id: 'u1', text: 'quick question' },
            { type: 'assistant_text', id: 'a1', text: 'quick answer' },
            {
              type: 'turn_meta',
              id: 'm1',
              provider: 'anthropic',
              model: 'claude-haiku-4-5',
              startedAt: 1,
              endedAt: 2,
              ursaRole: 'grunt'
            }
          ]
        }
      },
      convoOrder: ['c1']
    } as never)
    render(<ConversationView convoId="c1" />)
    const badge = screen.getByText(/grunt/)
    expect(badge.textContent).toContain('Claude Haiku 4.5')
  })

  it('renders no badge for a turn that did not run under Ursa', () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      modelRef: 'anthropic/claude-sonnet-5',
      providers: [],
      conversations: {
        c1: {
          id: 'c1',
          projectPath: '/p',
          title: 'T',
          modelRef: 'anthropic/claude-sonnet-5',
          permissionMode: 'accept-edits',
          updatedAt: 1,
          loaded: true,
          runState: 'idle',
          events: [
            { type: 'user_message', id: 'u1', text: 'hi' },
            { type: 'assistant_text', id: 'a1', text: 'hello' },
            {
              type: 'turn_meta',
              id: 'm1',
              provider: 'anthropic',
              model: 'claude-sonnet-5',
              startedAt: 1,
              endedAt: 2
            }
          ]
        }
      },
      convoOrder: ['c1']
    } as never)
    const { container } = render(<ConversationView convoId="c1" />)
    expect(container.querySelector('.msg-ursa-badge')).toBeNull()
  })
})

// F1 Task 7: jump-to-match. ConversationView consumes the transient
// `focusEventId` set by a content-search hit -- it scrolls the matching event
// into view, flashes a highlight, and (with more than one match) shows a
// next/prev navigator that advances `focusEventId` through `focusMatches`.
describe('ConversationView jump-to-match (F1)', () => {
  const focusConvo = {
    id: 'c1',
    projectPath: '/p',
    title: 'T',
    modelRef: 'anthropic/claude-sonnet-5',
    permissionMode: 'accept-edits',
    updatedAt: 1,
    loaded: true,
    runState: 'idle',
    events: [
      { type: 'user_message', id: 'u1', text: 'fox chicken grain' },
      { type: 'assistant_text', id: 'a1', text: 'the farmer crosses the river' },
      { type: 'turn_meta', id: 'm1', provider: 'anthropic', model: 'x', startedAt: 1, endedAt: 2 }
    ]
  }

  beforeEach(() => {
    // jsdom implements neither scrollIntoView nor matchMedia.
    Element.prototype.scrollIntoView = vi.fn()
    ;(window as unknown as { matchMedia: unknown }).matchMedia = vi
      .fn()
      .mockReturnValue({ matches: false })
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      modelRef: 'anthropic/claude-sonnet-5',
      providers: [],
      conversations: { c1: focusConvo },
      convoOrder: ['c1'],
      focusEventId: null,
      focusMatches: []
    } as never)
  })

  it('scrolls to and highlights the focused event', async () => {
    useAppStore.setState({ focusEventId: 'u1', focusMatches: ['u1'] } as never)
    render(<ConversationView convoId="c1" />)
    const row = document.querySelector('[data-event-id="u1"]') as HTMLElement
    expect(row).toBeTruthy()
    await waitFor(() => expect(row.classList.contains('event-focus-highlight')).toBe(true))
    expect(row.scrollIntoView).toHaveBeenCalled()
  })

  it('does not crash and clears focus when the focused event is not rendered', async () => {
    const clearFocusEvent = vi.fn()
    useAppStore.setState({
      focusEventId: 'gone',
      focusMatches: ['gone'],
      clearFocusEvent
    } as never)
    render(<ConversationView convoId="c1" />)
    await waitFor(() => expect(clearFocusEvent).toHaveBeenCalled())
    expect(document.querySelector('.event-focus-highlight')).toBeNull()
  })

  it('jumps to a tool_call or tool_result hit rendered inside a WorkedGroup', async () => {
    // tool_call + tool_result render as one paired ToolStep inside WorkedGroup.
    // Both event kinds are FTS-indexed, so a content-search hit can land on
    // either id -- the anchor must cover both.
    const toolConvo = {
      ...focusConvo,
      events: [
        { type: 'user_message', id: 'u1', text: 'edit the registry' },
        {
          type: 'tool_call',
          id: 'tc1',
          tool: 'edit_file',
          input: { path: 'src/registry.ts' },
          approvalState: 'approved'
        },
        {
          type: 'tool_result',
          id: 'tr1',
          callId: 'tc1',
          output: 'wrote src/registry.ts',
          durationMs: 1,
          truncated: false
        },
        { type: 'turn_meta', id: 'm1', provider: 'anthropic', model: 'x', startedAt: 1, endedAt: 2 }
      ]
    }
    useAppStore.setState({
      conversations: { c1: toolConvo },
      focusEventId: 'tr1',
      focusMatches: ['tc1', 'tr1']
    } as never)
    render(<ConversationView convoId="c1" />)
    const anchor = document.querySelector('[data-event-id~="tr1"]') as HTMLElement
    expect(anchor).toBeTruthy()
    await waitFor(() => expect(anchor.classList.contains('event-focus-highlight')).toBe(true))
    expect(anchor.scrollIntoView).toHaveBeenCalled()
  })

  it('jumps once events arrive for a not-yet-loaded conversation (async open)', async () => {
    // The main history-search path: openConvo sets focus while the conversation
    // is still loaded:false with empty events (conversations.get is in flight).
    // The focus effect must NOT clear focus on that first render -- it has to
    // wait for the events, then highlight. (Regression: the old effect ran once
    // on mount, found no anchor, cleared focus, and never re-ran.)
    useAppStore.setState({
      conversations: { c1: { ...focusConvo, loaded: false, events: [] } },
      focusEventId: 'u1',
      focusMatches: ['u1']
    } as never)
    render(<ConversationView convoId="c1" />)
    // Nothing to highlight yet, and focus survives (not cleared).
    expect(document.querySelector('.event-focus-highlight')).toBeNull()
    expect(useAppStore.getState().focusEventId).toBe('u1')

    // conversations.get resolves: events land and loaded flips true.
    useAppStore.setState({ conversations: { c1: { ...focusConvo, loaded: true } } } as never)

    await waitFor(() => {
      const row = document.querySelector('[data-event-id="u1"]') as HTMLElement | null
      expect(row?.classList.contains('event-focus-highlight')).toBe(true)
    })
    const row = document.querySelector('[data-event-id="u1"]') as HTMLElement
    expect(row.scrollIntoView).toHaveBeenCalled()
  })

  it('reorders bm25-ranked matches into transcript (document) order', async () => {
    // Hits arrive ranked by bm25 (a1 ahead of u1), but u1 precedes a1 in the
    // transcript. Once loaded, the navigator set is sorted to document order so
    // next/prev steps monotonically top-to-bottom.
    useAppStore.setState({ focusEventId: 'u1', focusMatches: ['a1', 'u1'] } as never)
    render(<ConversationView convoId="c1" />)
    await waitFor(() => expect(useAppStore.getState().focusMatches).toEqual(['u1', 'a1']))
  })

  it('fires the jump exactly once: new streamed events do not re-scroll or re-highlight', async () => {
    // Regression: the focus effect depends on convo.events (so it can catch the
    // async-load case), but it must fire for a given focusEventId only ONCE.
    // Otherwise every streamed event of a follow-up turn re-runs scrollIntoView
    // on the old match and re-flashes the highlight, pinning the transcript.
    useAppStore.setState({ focusEventId: 'u1', focusMatches: ['u1'] } as never)
    render(<ConversationView convoId="c1" />)
    const row = document.querySelector('[data-event-id="u1"]') as HTMLElement
    await waitFor(() => expect(row.classList.contains('event-focus-highlight')).toBe(true))
    const scrollMock = row.scrollIntoView as unknown as { mock: { calls: unknown[] } }
    const callsAfterJump = scrollMock.mock.calls.length

    // Remove the highlight so a spurious re-fire would be observable, then append
    // a new event (as a live turn would) WITHOUT clearing focus.
    row.classList.remove('event-focus-highlight')
    await act(async () => {
      useAppStore.setState({
        conversations: {
          c1: {
            ...focusConvo,
            events: [...focusConvo.events, { type: 'user_message', id: 'u2', text: 'follow up' }]
          }
        }
      } as never)
    })

    const rowAfter = document.querySelector('[data-event-id="u1"]') as HTMLElement
    // No second scroll, and the highlight is not re-applied for the same id.
    expect(scrollMock.mock.calls.length).toBe(callsAfterJump)
    expect(rowAfter.classList.contains('event-focus-highlight')).toBe(false)
  })

  it('renders an "N of M" navigator and stepFocus advances the highlight', async () => {
    useAppStore.setState({ focusEventId: 'u1', focusMatches: ['u1', 'a1'] } as never)
    render(<ConversationView convoId="c1" />)
    await waitFor(() =>
      expect(
        document.querySelector('[data-event-id="u1"]')?.classList.contains('event-focus-highlight')
      ).toBe(true)
    )
    expect(screen.getByText(/1 of 2/i)).toBeTruthy()

    fireEvent.click(screen.getByLabelText(/next match/i))

    await waitFor(() =>
      expect(
        document.querySelector('[data-event-id="a1"]')?.classList.contains('event-focus-highlight')
      ).toBe(true)
    )
    expect(screen.getByText(/2 of 2/i)).toBeTruthy()
  })
})

describe('ConversationView pinned approval', () => {
  const baseConvo = {
    id: 'c1',
    projectPath: '/p',
    title: 'T',
    modelRef: 'anthropic/claude-sonnet-5',
    permissionMode: 'accept-edits',
    updatedAt: 1,
    loaded: true,
    runState: 'awaiting-approval'
  }

  it('renders a second, pinned copy of the pending approval card above the composer', () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      modelRef: 'anthropic/claude-sonnet-5',
      providers: [],
      conversations: {
        c1: {
          ...baseConvo,
          events: [
            { type: 'user_message', id: 'u1', text: 'build it' },
            {
              type: 'tool_call',
              id: 't1',
              tool: 'run_command',
              input: { command: 'open index.html' },
              approvalState: 'pending'
            }
          ]
        }
      },
      convoOrder: ['c1']
    } as never)
    const { container } = render(<ConversationView convoId="c1" />)
    // Two ToolStep instances render (the transcript record + the pinned copy);
    // CSS hides the transcript copy's .approval-card so only the pinned card
    // is ever visible (jsdom doesn't apply stylesheets, so assert structure).
    expect(screen.getAllByText('Allow running this command?')).toHaveLength(2)
    expect(container.querySelector('.pinned-approval')).not.toBeNull()
    // Hotkey/anchor/number-chip singletons live on the PINNED copy -- the
    // interactive card at the composer: exactly one anchor id, inside it.
    expect(container.querySelectorAll('#pending-approval-card')).toHaveLength(1)
    expect(container.querySelector('.pinned-approval #pending-approval-card')).not.toBeNull()
    expect(container.querySelectorAll('.pinned-approval .opt-num').length).toBeGreaterThan(0)
    expect(container.querySelector('.convo-scroll .opt-num')).toBeNull()
  })

  it('drops the pinned copy once the approval resolves', () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'c1' },
      modelRef: 'anthropic/claude-sonnet-5',
      providers: [],
      conversations: {
        c1: {
          ...baseConvo,
          runState: 'running',
          events: [
            { type: 'user_message', id: 'u1', text: 'build it' },
            {
              type: 'tool_call',
              id: 't1',
              tool: 'run_command',
              input: { command: 'open index.html' },
              approvalState: 'approved'
            }
          ]
        }
      },
      convoOrder: ['c1']
    } as never)
    const { container } = render(<ConversationView convoId="c1" />)
    expect(container.querySelector('.pinned-approval')).toBeNull()
    expect(screen.queryByText('Allow running this command?')).toBeNull()
  })
})

describe('ConversationView pinned Hermes interactions', () => {
  const resolveApproval = vi.fn(() => Promise.resolve())
  const resolveClarification = vi.fn(() => Promise.resolve())
  const baseConvo = {
    id: 'h1',
    projectPath: null,
    title: 'Hermes',
    modelRef: 'hermes/agent',
    permissionMode: 'accept-edits',
    updatedAt: 1,
    loaded: true,
    runState: 'awaiting-approval'
  }

  beforeEach(() => {
    resolveApproval.mockReset()
    resolveApproval.mockResolvedValue(undefined)
    resolveClarification.mockReset()
    resolveClarification.mockResolvedValue(undefined)
    ;(window as unknown as { bearcode: BearcodeApi }).bearcode = {
      attachments: {
        pick: vi.fn(async () => ({ picked: [], errors: [] })),
        read: vi.fn(async () => null),
        open: vi.fn(async () => undefined)
      },
      hermes: { resolveApproval, resolveClarification }
    } as unknown as BearcodeApi
  })

  it('pins only the first pending native interaction in event order and keeps transcript copies passive', () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'h1' },
      modelRef: 'hermes/agent',
      providers: [],
      settings: { hermesEnabled: true },
      conversations: {
        h1: {
          ...baseConvo,
          events: [
            { type: 'user_message', id: 'u1', text: 'deploy it' },
            {
              type: 'hermes_tool_call',
              id: 'tool-1',
              name: 'deploy',
              label: 'Deploy',
              status: 'awaiting-approval',
              requestId: 'approval-request',
              command: 'deploy --production'
            },
            {
              type: 'hermes_clarification',
              id: 'clarify-1',
              requestId: 'clarification-request',
              question: 'Which region?',
              choices: ['US', 'EU'],
              state: 'pending'
            }
          ]
        }
      },
      convoOrder: ['h1']
    } as never)

    const { container } = render(<ConversationView convoId="h1" />)
    const allowButtons = screen.getAllByRole('button', { name: 'Allow Once' })
    expect(allowButtons).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'US' })).toBeNull()
    expect(container.querySelectorAll('.pinned-approval')).toHaveLength(1)

    fireEvent.click(allowButtons[0])
    expect(resolveApproval).toHaveBeenCalledWith('h1', 'approval-request', 'once')
  })

  it('pins a pending clarification first when it precedes an approval', () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'h1' },
      modelRef: 'hermes/agent',
      providers: [],
      settings: { hermesEnabled: true },
      conversations: {
        h1: {
          ...baseConvo,
          events: [
            { type: 'user_message', id: 'u1', text: 'deploy it' },
            {
              type: 'hermes_clarification',
              id: 'clarify-1',
              requestId: 'clarification-request',
              question: 'Which region?',
              choices: ['US', 'EU'],
              state: 'pending'
            },
            {
              type: 'hermes_tool_call',
              id: 'tool-1',
              name: 'deploy',
              label: 'Deploy',
              status: 'awaiting-approval',
              requestId: 'approval-request'
            }
          ]
        }
      },
      convoOrder: ['h1']
    } as never)

    render(<ConversationView convoId="h1" />)
    expect(screen.getAllByRole('button', { name: 'US' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Allow Once' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'US' }))
    expect(resolveClarification).toHaveBeenCalledWith('h1', 'clarification-request', 'US')
  })

  it('pairs native tool results to calls by callId when results arrive out of order', () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'h1' },
      modelRef: 'hermes/agent',
      providers: [],
      settings: { hermesEnabled: true },
      conversations: {
        h1: {
          ...baseConvo,
          runState: 'idle',
          events: [
            { type: 'user_message', id: 'u1', text: 'run both' },
            {
              type: 'hermes_tool_call',
              id: 'tool-1',
              name: 'vendor.first',
              label: 'Tool One',
              status: 'running'
            },
            {
              type: 'hermes_tool_call',
              id: 'tool-2',
              name: 'vendor.second',
              label: 'Tool Two',
              status: 'running'
            },
            {
              type: 'hermes_tool_result',
              id: 'result-2',
              callId: 'tool-2',
              status: 'failed',
              durationMs: 2000
            },
            {
              type: 'hermes_tool_result',
              id: 'result-1',
              callId: 'tool-1',
              status: 'completed',
              durationMs: 1000
            }
          ]
        }
      },
      convoOrder: ['h1']
    } as never)

    render(<ConversationView convoId="h1" />)
    expect(screen.getByText('Tool One').closest('.step')?.textContent).toContain('Completed · 1s')
    expect(screen.getByText('Tool Two').closest('.step')?.textContent).toContain('Failed · 2s')
  })

  it('enables approval B after approval A resolves in the same pinned position', async () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'h1' },
      modelRef: 'hermes/agent',
      providers: [],
      settings: { hermesEnabled: true },
      conversations: {
        h1: {
          ...baseConvo,
          events: [
            { type: 'user_message', id: 'u1', text: 'deploy it' },
            {
              type: 'hermes_tool_call',
              id: 'tool-a',
              name: 'deploy',
              label: 'Deploy A',
              status: 'awaiting-approval',
              requestId: 'request-a'
            }
          ]
        }
      },
      convoOrder: ['h1']
    } as never)
    render(<ConversationView convoId="h1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Allow Once' }))
    expect(resolveApproval).toHaveBeenCalledWith('h1', 'request-a', 'once')

    await act(async () => {
      useAppStore.setState({
        conversations: {
          h1: {
            ...baseConvo,
            events: [
              { type: 'user_message', id: 'u1', text: 'deploy it' },
              {
                type: 'hermes_tool_call',
                id: 'tool-a',
                name: 'deploy',
                label: 'Deploy A',
                status: 'completed',
                requestId: 'request-a'
              },
              {
                type: 'hermes_tool_call',
                id: 'tool-b',
                name: 'deploy',
                label: 'Deploy B',
                status: 'awaiting-approval',
                requestId: 'request-b'
              }
            ]
          }
        }
      } as never)
    })

    const nextAllow = screen.getByRole('button', { name: 'Allow Once' })
    expect(nextAllow).toBeEnabled()
    fireEvent.click(nextAllow)
    expect(resolveApproval).toHaveBeenLastCalledWith('h1', 'request-b', 'once')
  })

  it('enables clarification B after clarification A resolves in the same pinned position', async () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'h1' },
      modelRef: 'hermes/agent',
      providers: [],
      settings: { hermesEnabled: true },
      conversations: {
        h1: {
          ...baseConvo,
          events: [
            { type: 'user_message', id: 'u1', text: 'deploy it' },
            {
              type: 'hermes_clarification',
              id: 'clarify-a',
              requestId: 'request-a',
              question: 'First region?',
              choices: ['US'],
              state: 'pending'
            }
          ]
        }
      },
      convoOrder: ['h1']
    } as never)
    render(<ConversationView convoId="h1" />)

    fireEvent.click(screen.getByRole('button', { name: 'US' }))
    expect(resolveClarification).toHaveBeenCalledWith('h1', 'request-a', 'US')

    await act(async () => {
      useAppStore.setState({
        conversations: {
          h1: {
            ...baseConvo,
            events: [
              { type: 'user_message', id: 'u1', text: 'deploy it' },
              {
                type: 'hermes_clarification',
                id: 'clarify-a',
                requestId: 'request-a',
                question: 'First region?',
                choices: ['US'],
                state: 'answered',
                response: 'US'
              },
              {
                type: 'hermes_clarification',
                id: 'clarify-b',
                requestId: 'request-b',
                question: 'Second region?',
                choices: ['EU'],
                state: 'pending'
              }
            ]
          }
        }
      } as never)
    })

    const nextChoice = screen.getByRole('button', { name: 'EU' })
    expect(nextChoice).toBeEnabled()
    fireEvent.click(nextChoice)
    expect(resolveClarification).toHaveBeenLastCalledWith('h1', 'request-b', 'EU')
  })

  it('skips a malformed approval without requestId and pins the later clarification', () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'h1' },
      modelRef: 'hermes/agent',
      providers: [],
      settings: { hermesEnabled: true },
      conversations: {
        h1: {
          ...baseConvo,
          events: [
            { type: 'user_message', id: 'u1', text: 'deploy it' },
            {
              type: 'hermes_tool_call',
              id: 'tool-malformed',
              name: 'deploy',
              label: 'Malformed approval',
              status: 'awaiting-approval'
            },
            {
              type: 'hermes_clarification',
              id: 'clarify-valid',
              requestId: 'clarify-request',
              question: 'Which region?',
              choices: ['US'],
              state: 'pending'
            }
          ]
        }
      },
      convoOrder: ['h1']
    } as never)

    render(<ConversationView convoId="h1" />)
    expect(screen.queryByRole('button', { name: 'Allow Once' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'US' }))
    expect(resolveClarification).toHaveBeenCalledWith('h1', 'clarify-request', 'US')
  })

  it('does not pair a result when duplicate native calls share its callId', () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'h1' },
      modelRef: 'hermes/agent',
      providers: [],
      settings: { hermesEnabled: true },
      conversations: {
        h1: {
          ...baseConvo,
          runState: 'idle',
          events: [
            { type: 'user_message', id: 'u1', text: 'run it' },
            {
              type: 'hermes_tool_call',
              id: 'duplicate-call',
              name: 'vendor.first',
              label: 'First duplicate',
              status: 'running'
            },
            {
              type: 'hermes_tool_call',
              id: 'duplicate-call',
              name: 'vendor.second',
              label: 'Second duplicate',
              status: 'running'
            },
            {
              type: 'hermes_tool_result',
              id: 'result-1',
              callId: 'duplicate-call',
              status: 'completed',
              durationMs: 1000
            }
          ]
        }
      },
      convoOrder: ['h1']
    } as never)

    render(<ConversationView convoId="h1" />)
    expect(screen.getByText('First duplicate').closest('.step')?.textContent).toContain('Running')
    expect(screen.getByText('Second duplicate').closest('.step')?.textContent).toContain('Running')
    expect(screen.getAllByText(/unmatched hermes result/i)).toHaveLength(1)
  })

  it('does not pair any result when a native call has duplicate results', () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'h1' },
      modelRef: 'hermes/agent',
      providers: [],
      settings: { hermesEnabled: true },
      conversations: {
        h1: {
          ...baseConvo,
          runState: 'idle',
          events: [
            { type: 'user_message', id: 'u1', text: 'run it' },
            {
              type: 'hermes_tool_call',
              id: 'tool-1',
              name: 'vendor.tool',
              label: 'Duplicate results',
              status: 'running'
            },
            {
              type: 'hermes_tool_result',
              id: 'result-1',
              callId: 'tool-1',
              status: 'completed',
              durationMs: 1000
            },
            {
              type: 'hermes_tool_result',
              id: 'result-2',
              callId: 'tool-1',
              status: 'failed',
              durationMs: 2000
            }
          ]
        }
      },
      convoOrder: ['h1']
    } as never)

    render(<ConversationView convoId="h1" />)
    expect(screen.getByText('Duplicate results').closest('.step')?.textContent).toContain('Running')
    expect(screen.getAllByText(/unmatched hermes result/i)).toHaveLength(2)
  })

  it('renders both a missing-result call and a missing-call result safely', () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'h1' },
      modelRef: 'hermes/agent',
      providers: [],
      settings: { hermesEnabled: true },
      conversations: {
        h1: {
          ...baseConvo,
          runState: 'idle',
          events: [
            { type: 'user_message', id: 'u1', text: 'run it' },
            {
              type: 'hermes_tool_call',
              id: 'call-without-result',
              name: 'vendor.tool',
              label: 'No result',
              status: 'running'
            },
            {
              type: 'hermes_tool_result',
              id: 'result-without-call',
              callId: 'missing-call',
              status: 'failed',
              durationMs: 2000
            }
          ]
        }
      },
      convoOrder: ['h1']
    } as never)

    render(<ConversationView convoId="h1" />)
    expect(screen.getByText('No result').closest('.step')?.textContent).toContain('Running')
    expect(screen.getByText(/unmatched hermes result/i).closest('.step')?.textContent).toContain(
      'Failed · 2s'
    )
  })
})

// Task 12: pre-events EmptyState for a not-yet-configured Hermes conversation,
// plus verification that runHermes's standard `{ type: 'error', recoverable }`
// events (Task 5) render inline via the same generic ErrorCard path every
// other conversation type uses -- no new error-rendering code needed.
describe('Hermes conversation empty/error states', () => {
  const baseHermesConvo = {
    id: 'h1',
    projectPath: '/p',
    title: 'Hermes',
    modelRef: 'hermes/agent',
    permissionMode: 'accept-edits',
    updatedAt: 1,
    loaded: true,
    runState: 'idle'
  }

  it('shows a setup EmptyState for a Hermes conversation when Hermes is disabled', () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'h1' },
      modelRef: 'hermes/agent',
      providers: [],
      settings: { hermesEnabled: false },
      conversations: { h1: { ...baseHermesConvo, events: [] } },
      convoOrder: ['h1']
    } as never)
    const { container } = render(<ConversationView convoId="h1" />)
    expect(screen.getByText(/set up hermes/i)).toBeInTheDocument()
    expect(container.querySelector('.composer-wrap')).toBeNull()
  })

  it('renders a normal transcript when Hermes is enabled and events exist', () => {
    useAppStore.setState({
      view: { kind: 'conversation', id: 'h1' },
      modelRef: 'hermes/agent',
      providers: [],
      settings: { hermesEnabled: true },
      conversations: {
        h1: { ...baseHermesConvo, events: [{ type: 'user_message', id: 'e1', text: 'hi' }] }
      },
      convoOrder: ['h1']
    } as never)
    render(<ConversationView convoId="h1" />)
    expect(screen.getByText('hi')).toBeInTheDocument()
    expect(screen.queryByText(/set up hermes/i)).toBeNull()
  })

  it('does not show the setup EmptyState once a turn has started, even if it failed', () => {
    // The realistic "unreachable gateway" shape: runHermes (Task 5) always
    // emits through the same sink/appendEvent pipeline as every other
    // conversation type, so the failing turn still opens with a persisted
    // user_message before its error -- an orphan `error` event with no
    // preceding user_message never happens in practice (groupTurns only
    // buckets events into the turn a user_message opened).
    useAppStore.setState({
      view: { kind: 'conversation', id: 'h1' },
      modelRef: 'hermes/agent',
      providers: [],
      settings: { hermesEnabled: true },
      conversations: {
        h1: {
          ...baseHermesConvo,
          events: [
            { type: 'user_message', id: 'u1', text: 'hi' },
            {
              type: 'error',
              id: 'e1',
              message: 'Could not reach the Hermes gateway: fetch failed',
              recoverable: true
            }
          ]
        }
      },
      convoOrder: ['h1']
    } as never)
    const { container } = render(<ConversationView convoId="h1" />)
    expect(screen.queryByText(/set up hermes/i)).toBeNull()
    expect(screen.getByText('Could not reach the Hermes gateway: fetch failed')).toBeInTheDocument()
    // Renders via the plain, generic ErrorCard -- not a fatal crash screen.
    expect(container.querySelector('.error-card')).not.toBeNull()
    expect(container.querySelector('.retry-btn')).not.toBeNull()
  })
})
