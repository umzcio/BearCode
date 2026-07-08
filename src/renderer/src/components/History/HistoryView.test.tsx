// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import type { BearcodeApi, HistoryHit } from '@shared/types'
import { useAppStore } from '../../state/store'
import { HistoryView } from './HistoryView'
import { renderSnippet } from './snippet'

const search = vi.fn<(q: string) => Promise<HistoryHit[]>>()

beforeEach(() => {
  search.mockReset()
  ;(window as unknown as { bearcode: BearcodeApi }).bearcode = {
    history: { search }
  } as unknown as BearcodeApi
})
afterEach(cleanup)

function seed(openConvo = vi.fn()): typeof openConvo {
  const now = Date.now()
  useAppStore.setState({
    view: { kind: 'history' },
    openConvo,
    conversations: {
      c1: {
        id: 'c1',
        projectLabel: 'proj',
        title: 'Fox puzzle',
        modelRef: 'anthropic/claude-sonnet-5',
        updatedAt: now,
        events: [{ type: 'user_message', id: 'u1', text: 'fox chicken grain' }]
      },
      c2: {
        id: 'c2',
        projectLabel: 'proj',
        title: 'Old chat',
        modelRef: 'anthropic/claude-sonnet-5',
        updatedAt: now - 40 * 86400000,
        events: []
      }
    },
    convoOrder: ['c1', 'c2'],
    projects: []
  } as never)
  return openConvo
}

describe('renderSnippet', () => {
  it('parses ‹mark› sentinels into <mark> nodes and keeps surrounding text', () => {
    const { container } = render(<div>{renderSnippet('the ‹mark›fox‹/mark› runs')}</div>)
    const mark = container.querySelector('mark')
    expect(mark?.textContent).toBe('fox')
    expect(container.textContent).toBe('the fox runs')
  })

  it('passes through plain text with no sentinels', () => {
    const { container } = render(<div>{renderSnippet('no marks here')}</div>)
    expect(container.querySelector('mark')).toBeNull()
    expect(container.textContent).toBe('no marks here')
  })
})

describe('HistoryView browse', () => {
  it('renders time-bucket headers and conversation titles when query is empty', () => {
    seed()
    render(<HistoryView />)
    expect(screen.getByText('Today')).toBeTruthy()
    expect(screen.getByText('Older')).toBeTruthy()
    expect(screen.getByText('Fox puzzle')).toBeTruthy()
    expect(screen.getByText('Old chat')).toBeTruthy()
  })

  it('opens a conversation with no focus when a browse row is clicked', () => {
    const openConvo = seed(vi.fn())
    render(<HistoryView />)
    fireEvent.click(screen.getByText('Fox puzzle'))
    expect(openConvo).toHaveBeenCalledWith('c1')
  })
})

describe('HistoryView content search', () => {
  it('calls history.search on input and renders snippet rows with <mark>', async () => {
    seed()
    search.mockResolvedValue([
      {
        conversationId: 'c1',
        eventId: 'u1',
        kind: 'user_message',
        snippet: 'the ‹mark›fox‹/mark› chicken grain',
        title: 'Fox puzzle',
        projectLabel: 'proj',
        updatedAt: Date.now()
      }
    ])
    const { container } = render(<HistoryView />)
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'fox' } })
    await waitFor(() => expect(search).toHaveBeenCalledWith('fox'))
    await waitFor(() => expect(container.querySelector('mark')).toBeTruthy())
    expect(container.querySelector('mark')?.textContent).toBe('fox')
  })

  it('clicking a content result opens the conversation with focusEventId', async () => {
    const openConvo = seed(vi.fn())
    search.mockResolvedValue([
      {
        conversationId: 'c1',
        eventId: 'u1',
        kind: 'user_message',
        snippet: '‹mark›fox‹/mark›',
        title: 'Fox puzzle',
        projectLabel: 'proj',
        updatedAt: Date.now()
      }
    ])
    const { container } = render(<HistoryView />)
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'fox' } })
    await waitFor(() => expect(container.querySelector('.history-hit')).toBeTruthy())
    fireEvent.click(container.querySelector('.history-hit') as Element)
    expect(openConvo).toHaveBeenCalledWith('c1', { focusEventId: 'u1' })
  })
})
