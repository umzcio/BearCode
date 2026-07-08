// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useAppStore, type Convo } from '../../state/store'
import { SearchModal } from './SearchModal'

const convo = (
  id: string,
  title: string,
  projectPath: string | null = null,
  projectLabel = 'No folder'
): Convo => ({
  id,
  title,
  projectLabel,
  projectId: null,
  updatedAt: 1,
  createdAt: 0,
  pinned: false,
  archived: false,
  projectPath,
  modelRef: null,
  permissionMode: 'accept-edits' as const,
  effort: 'adaptive' as const,
  thinking: true,
  loaded: true,
  events: [],
  runState: 'idle' as const
})

beforeEach(() => {
  useAppStore.setState({
    searchOpen: true,
    conversations: {
      c1: convo('c1', 'Alpha'),
      c2: convo('c2', 'Beta', '/Users/zach/Campus', 'Campus')
    },
    convoOrder: ['c1', 'c2'],
    folderSettings: [],
    view: { kind: 'home' }
  })
})
afterEach(cleanup)

describe('SearchModal (folder = project)', () => {
  it('renders nothing when closed', () => {
    useAppStore.setState({ searchOpen: false })
    const { container } = render(<SearchModal />)
    expect(container.firstChild).toBeNull()
  })
  it('lists conversations and folders', () => {
    render(<SearchModal />)
    expect(screen.getByText('Alpha')).toBeTruthy()
    // A folder entry (derived from c2's projectPath, basename label) renders with
    // the 'Folder' subtitle; 'Campus' itself appears twice (folder title + c2's
    // subtitle), so assert on the unambiguous subtitle here.
    expect(screen.getByText('Folder')).toBeTruthy()
    expect(screen.getAllByText('Campus').length).toBeGreaterThanOrEqual(1)
  })
  it('filters by query', () => {
    render(<SearchModal />)
    fireEvent.change(screen.getByPlaceholderText(/search chats and projects/i), {
      target: { value: 'camp' }
    })
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
  it('selecting a folder opens its most-recent conversation', () => {
    render(<SearchModal />)
    // Click the folder row via its unambiguous 'Folder' subtitle (the click
    // bubbles to the row's onClick).
    fireEvent.click(screen.getByText('Folder'))
    expect(useAppStore.getState().view).toEqual({ kind: 'conversation', id: 'c2' })
  })
  it('uses a custom folder name override for the folder label', () => {
    useAppStore.setState({
      folderSettings: [
        {
          path: '/Users/zach/Campus',
          name: 'Campus Work',
          color: null,
          icon: null,
          defaultModelRef: null,
          defaultEffort: null,
          defaultPermissionMode: null
        }
      ] as never
    })
    render(<SearchModal />)
    expect(screen.getByText('Campus Work')).toBeTruthy()
  })
})
