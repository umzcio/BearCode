// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useAppStore } from '../../state/store'
import { ConvoRowMenu } from './ConvoRowMenu'

beforeEach(() => {
  useAppStore.setState({
    projects: [{ id: 'p1', name: 'Campus', color: null, createdAt: 0, updatedAt: 0 }]
  })
})
afterEach(cleanup)

describe('ConvoRowMenu', () => {
  it('opens on the ⋮ button and lists Rename / Move to project / Delete', () => {
    render(<ConvoRowMenu convoId="c1" title="T" projectId={null} />)
    fireEvent.click(screen.getByTitle('More'))
    expect(screen.getByText('Rename')).toBeTruthy()
    expect(screen.getByText(/move to project/i)).toBeTruthy()
    expect(screen.getByText('Delete Conversation')).toBeTruthy()
    expect(screen.getByText('Campus')).toBeTruthy() // a project option
  })
  it('Move to a project calls assignConversationProject', () => {
    const spy = vi.fn()
    useAppStore.setState({ assignConversationProject: spy as never })
    render(<ConvoRowMenu convoId="c1" title="T" projectId={null} />)
    fireEvent.click(screen.getByTitle('More'))
    fireEvent.click(screen.getByText('Campus'))
    expect(spy).toHaveBeenCalledWith('c1', 'p1')
  })
})
