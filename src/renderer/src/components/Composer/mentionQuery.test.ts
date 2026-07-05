import { describe, it, expect } from 'vitest'
import {
  activeMentionQuery,
  buildMentionRows,
  mentionCategoryPrefix,
  parseMentionQuery
} from './mentionQuery'
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

describe('parseMentionQuery', () => {
  it('treats a bare query (no colon) as category-chooser mode', () => {
    expect(parseMentionQuery('')).toEqual({ category: null, sub: '' })
    expect(parseMentionQuery('conv')).toEqual({ category: null, sub: 'conv' })
  })

  it('recognizes each category prefix and splits off the sub-query', () => {
    expect(parseMentionQuery('file:src/a')).toEqual({ category: 'file', sub: 'src/a' })
    expect(parseMentionQuery('rule:sty')).toEqual({ category: 'rule', sub: 'sty' })
    expect(parseMentionQuery('conversation:cha')).toEqual({ category: 'conversation', sub: 'cha' })
    expect(parseMentionQuery('conversation:')).toEqual({ category: 'conversation', sub: '' })
  })

  it('is case-insensitive on the prefix and ignores unknown prefixes', () => {
    expect(parseMentionQuery('Rule:x')).toEqual({ category: 'rule', sub: 'x' })
    expect(parseMentionQuery('bogus:x')).toEqual({ category: null, sub: 'bogus:x' })
  })

  it('round-trips with mentionCategoryPrefix', () => {
    expect(parseMentionQuery(mentionCategoryPrefix('conversation'))).toEqual({
      category: 'conversation',
      sub: ''
    })
  })
})

describe('buildMentionRows', () => {
  const rules: ManualRuleInfo[] = [{ name: 'style', firstLine: 'Use tabs.' }]
  const base = { files: ['src/a.ts'], rules, conversations: [{ id: 'c1', title: 'Some chat' }] }

  it('category mode (no category) returns the three category chooser rows', () => {
    const out = buildMentionRows({ category: null, sub: '', ...base })
    expect(out.map((r) => r.type)).toEqual(['category', 'category', 'category'])
    expect(out.map((r) => (r.type === 'category' ? r.kind : null))).toEqual([
      'file',
      'rule',
      'conversation'
    ])
  })

  it('category mode filters the chooser by a subsequence on the label', () => {
    const out = buildMentionRows({ category: null, sub: 'conv', ...base })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ type: 'category', kind: 'conversation' })
  })

  it('file item mode passes files through (pre-ranked) as item rows', () => {
    const out = buildMentionRows({ category: 'file', sub: 'zzz', ...base })
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      type: 'item',
      suggestion: { ref: { kind: 'file', name: 'src/a.ts', path: 'src/a.ts' }, label: 'src/a.ts' }
    })
  })

  it('rule item mode filters rules by the sub-query', () => {
    expect(buildMentionRows({ category: 'rule', sub: 'sty', ...base })).toHaveLength(1)
    expect(buildMentionRows({ category: 'rule', sub: 'zzz', ...base })).toHaveLength(0)
  })

  it('conversation item mode filters conversations by the sub-query', () => {
    expect(buildMentionRows({ category: 'conversation', sub: 'chat', ...base })).toHaveLength(1)
    expect(buildMentionRows({ category: 'conversation', sub: 'zzz', ...base })).toHaveLength(0)
  })

  it('caps the drilled-in item list at 8', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, title: `Chat ${i}` }))
    const out = buildMentionRows({ category: 'conversation', sub: '', files: [], rules: [], conversations: many })
    expect(out).toHaveLength(8)
  })
})
