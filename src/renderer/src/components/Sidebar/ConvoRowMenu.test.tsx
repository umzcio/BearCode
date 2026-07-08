// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useAppStore } from '../../state/store'
import { ConvoRowMenu } from './ConvoRowMenu'

afterEach(cleanup)

describe('ConvoRowMenu (folder = project)', () => {
  it('opens on the ⋮ button and lists Rename / Delete (no move-to-project)', () => {
    render(<ConvoRowMenu convoId="c1" title="T" />)
    fireEvent.click(screen.getByTitle('More'))
    expect(screen.getByText('Rename')).toBeTruthy()
    expect(screen.getByText('Delete Conversation')).toBeTruthy()
    // A conversation belongs to the folder it was created in — no move menu.
    expect(screen.queryByText(/move to project/i)).toBeNull()
  })
  it('Delete calls deleteConvo after confirm', () => {
    const spy = vi.fn()
    useAppStore.setState({ deleteConvo: spy as never })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<ConvoRowMenu convoId="c1" title="T" />)
    fireEvent.click(screen.getByTitle('More'))
    fireEvent.click(screen.getByText('Delete Conversation'))
    expect(spy).toHaveBeenCalledWith('c1')
  })
})
