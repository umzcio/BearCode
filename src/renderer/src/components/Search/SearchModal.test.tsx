// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useAppStore, type Convo } from '../../state/store'
import { SearchModal } from './SearchModal'

const convo = (id: string, title: string, projectId: string | null = null): Convo => ({
  id, title, projectLabel: 'repo', projectId, updatedAt: 1, projectPath: null,
  modelRef: null, permissionMode: 'accept-edits' as const, effort: 'adaptive' as const,
  thinking: true, loaded: true, events: [], runState: 'idle' as const
})

beforeEach(() => {
  useAppStore.setState({
    searchOpen: true,
    conversations: { c1: convo('c1', 'Alpha'), c2: convo('c2', 'Beta', 'p1') },
    convoOrder: ['c1', 'c2'],
    projects: [{ id: 'p1', name: 'Campus', color: null, createdAt: 0, updatedAt: 9 }],
    view: { kind: 'home' }
  })
})
afterEach(cleanup)

describe('SearchModal', () => {
  it('renders nothing when closed', () => {
    useAppStore.setState({ searchOpen: false })
    const { container } = render(<SearchModal />)
    expect(container.firstChild).toBeNull()
  })
  it('lists conversations and projects', () => {
    render(<SearchModal />)
    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.getByText('Campus')).toBeTruthy()
  })
  it('filters by query', () => {
    render(<SearchModal />)
    fireEvent.change(screen.getByPlaceholderText(/search chats and projects/i), { target: { value: 'camp' } })
    expect(screen.getByText('Campus')).toBeTruthy()
    expect(screen.queryByText('Alpha')).toBeNull()
  })
  it('Enter opens the highlighted conversation and closes', async () => {
    render(<SearchModal />)
    // The keydown listener attaches on a deferred tick (mirrors ResumePicker)
    // so the ⌘K/click that opened the modal isn't caught; flush that tick.
    await new Promise((r) => setTimeout(r, 0))
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(useAppStore.getState().view).toEqual({ kind: 'conversation', id: 'c1' })
    expect(useAppStore.getState().searchOpen).toBe(false)
  })
  it('Escape closes', async () => {
    render(<SearchModal />)
    await new Promise((r) => setTimeout(r, 0))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useAppStore.getState().searchOpen).toBe(false)
  })
  it('selecting a project opens its most-recent conversation', () => {
    render(<SearchModal />)
    fireEvent.click(screen.getByText('Campus'))
    expect(useAppStore.getState().view).toEqual({ kind: 'conversation', id: 'c2' })
  })
})
