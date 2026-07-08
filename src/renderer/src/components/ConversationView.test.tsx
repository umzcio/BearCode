// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
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
})
afterEach(cleanup)

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

  it('renders an "N of M" navigator and stepFocus advances the highlight', async () => {
    useAppStore.setState({ focusEventId: 'u1', focusMatches: ['u1', 'a1'] } as never)
    render(<ConversationView convoId="c1" />)
    await waitFor(() =>
      expect(
        document.querySelector('[data-event-id="u1"]')?.classList.contains('event-focus-highlight')
      ).toBe(true)
    )
    expect(screen.getByText(/1 of 2/i)).toBeTruthy()

    fireEvent.click(screen.getByTitle(/next match/i))

    await waitFor(() =>
      expect(
        document.querySelector('[data-event-id="a1"]')?.classList.contains('event-focus-highlight')
      ).toBe(true)
    )
    expect(screen.getByText(/2 of 2/i)).toBeTruthy()
  })
})
