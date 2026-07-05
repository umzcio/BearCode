import { describe, it, expect } from 'vitest'
import { activeMentionQuery, buildMentionSuggestions } from './mentionQuery'
import type { ManualRuleInfo } from '@shared/types'

describe('activeMentionQuery', () => {
  it('detects an @ token at the start of the text', () => {
    expect(activeMentionQuery('@comp', 5)).toEqual({ start: 0, query: 'comp' })
  })

  it('detects an @ token after whitespace', () => {
    expect(activeMentionQuery('hello @sty', 10)).toEqual({ start: 6, query: 'sty' })
  })

  it('returns null when the @ is glued to a non-space char (email-like)', () => {
    expect(activeMentionQuery('me@host', 7)).toBeNull()
  })

  it('returns null when there is whitespace between @ and the caret', () => {
    expect(activeMentionQuery('@foo bar', 8)).toBeNull()
  })

  it('returns null when there is no @ before the caret', () => {
    expect(activeMentionQuery('plain text', 5)).toBeNull()
  })

  it('reads the query only up to the caret', () => {
    expect(activeMentionQuery('@abcdef', 3)).toEqual({ start: 0, query: 'ab' })
  })
})

describe('buildMentionSuggestions', () => {
  const rules: ManualRuleInfo[] = [{ name: 'style', firstLine: 'Use tabs.' }]
  it('orders Files, then Rules, then Conversations; each subsequence-filtered', () => {
    const out = buildMentionSuggestions({
      query: 's',
      files: ['src/a.ts'],
      rules,
      conversations: [{ id: 'c1', title: 'Some chat' }]
    })
    expect(out.map((s) => s.ref.kind)).toEqual(['file', 'rule', 'conversation'])
    expect(out[0]).toEqual({ ref: { kind: 'file', name: 'src/a.ts', path: 'src/a.ts' }, label: 'src/a.ts' })
    expect(out[1]).toEqual({ ref: { kind: 'rule', name: 'style' }, label: 'style', detail: 'Use tabs.' })
    expect(out[2]).toEqual({
      ref: { kind: 'conversation', name: 'Some chat', conversationId: 'c1' },
      label: 'Some chat'
    })
  })

  it('passes files through as-is (already ranked main-side) but filters rules/conversations by query', () => {
    const out = buildMentionSuggestions({
      query: 'zzz',
      files: ['src/a.ts'],
      rules,
      conversations: [{ id: 'c1', title: 'Some chat' }]
    })
    // files come pre-ranked from IPC, so they are not re-filtered here
    expect(out.filter((s) => s.ref.kind === 'file')).toHaveLength(1)
    expect(out.filter((s) => s.ref.kind !== 'file')).toHaveLength(0)
  })
})
