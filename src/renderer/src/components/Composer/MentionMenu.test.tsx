// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { MentionMenu } from './MentionMenu'
import type { MentionRow } from './mentionQuery'

afterEach(cleanup)

const categoryRows: MentionRow[] = [
  { type: 'category', kind: 'file', label: 'Files' },
  { type: 'category', kind: 'rule', label: 'Rules' },
  { type: 'category', kind: 'conversation', label: 'Conversations' }
]

const itemRows: MentionRow[] = [
  { type: 'item', suggestion: { ref: { kind: 'conversation', name: 'Old chat', conversationId: 'c1' }, label: 'Old chat' } },
  { type: 'item', suggestion: { ref: { kind: 'conversation', name: 'New chat', conversationId: 'c2' }, label: 'New chat' } }
]

describe('MentionMenu', () => {
  it('category mode renders the three chooser rows (no header)', () => {
    render(
      <MentionMenu rows={categoryRows} header={null} highlightedIndex={0} onHighlight={vi.fn()} onSelect={vi.fn()} />
    )
    expect(screen.getByText('Files')).toBeTruthy()
    expect(screen.getByText('Rules')).toBeTruthy()
    expect(screen.getByText('Conversations')).toBeTruthy()
  })

  it('item mode renders the category header + item labels', () => {
    render(
      <MentionMenu rows={itemRows} header="Conversations" highlightedIndex={0} onHighlight={vi.fn()} onSelect={vi.fn()} />
    )
    expect(screen.getByText('Conversations')).toBeTruthy() // header
    expect(screen.getByText('Old chat')).toBeTruthy()
    expect(screen.getByText('New chat')).toBeTruthy()
  })

  it('shows an empty message when there are no rows', () => {
    render(<MentionMenu rows={[]} header="Rules" highlightedIndex={0} onHighlight={vi.fn()} onSelect={vi.fn()} />)
    expect(screen.getByText('No matches.')).toBeTruthy()
  })

  it('calls onSelect with the clicked category row', () => {
    const onSelect = vi.fn()
    render(
      <MentionMenu rows={categoryRows} header={null} highlightedIndex={0} onHighlight={vi.fn()} onSelect={onSelect} />
    )
    fireEvent.click(screen.getByText('Conversations'))
    expect(onSelect).toHaveBeenCalledWith(categoryRows[2])
  })

  it('calls onSelect with the clicked item row', () => {
    const onSelect = vi.fn()
    render(
      <MentionMenu rows={itemRows} header="Conversations" highlightedIndex={0} onHighlight={vi.fn()} onSelect={onSelect} />
    )
    fireEvent.click(screen.getByText('New chat'))
    expect(onSelect).toHaveBeenCalledWith(itemRows[1])
  })
})
