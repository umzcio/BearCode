// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { MentionMenu } from './MentionMenu'
import type { MentionSuggestion } from './mentionQuery'

afterEach(cleanup)

const items: MentionSuggestion[] = [
  { ref: { kind: 'file', name: 'src/a.ts', path: 'src/a.ts' }, label: 'src/a.ts' },
  { ref: { kind: 'rule', name: 'style' }, label: 'style', detail: 'Use tabs.' },
  { ref: { kind: 'conversation', name: 'Old chat', conversationId: 'c1' }, label: 'Old chat' }
]

describe('MentionMenu', () => {
  it('renders a category header per kind and all labels', () => {
    render(<MentionMenu items={items} highlightedIndex={0} onHighlight={vi.fn()} onSelect={vi.fn()} />)
    expect(screen.getByText('Files')).toBeTruthy()
    expect(screen.getByText('Rules')).toBeTruthy()
    expect(screen.getByText('Conversations')).toBeTruthy()
    expect(screen.getByText('src/a.ts')).toBeTruthy()
    expect(screen.getByText('Old chat')).toBeTruthy()
  })

  it('shows an empty message when there are no items', () => {
    render(<MentionMenu items={[]} highlightedIndex={0} onHighlight={vi.fn()} onSelect={vi.fn()} />)
    expect(screen.getByText('No matches.')).toBeTruthy()
  })

  it('calls onSelect with the clicked suggestion', () => {
    const onSelect = vi.fn()
    render(<MentionMenu items={items} highlightedIndex={0} onHighlight={vi.fn()} onSelect={onSelect} />)
    fireEvent.click(screen.getByText('style'))
    expect(onSelect).toHaveBeenCalledWith(items[1])
  })
})
