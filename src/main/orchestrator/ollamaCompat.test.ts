import { describe, it, expect } from 'vitest'
import { stringifyToolContent } from './ollamaCompat'

describe('stringifyToolContent', () => {
  it('passes strings through unchanged', () => {
    expect(stringifyToolContent('hello')).toBe('hello')
  })

  it('joins an array of line strings with newlines (Deep Agents file tools)', () => {
    expect(stringifyToolContent(['line 1', 'line 2', 'line 3'])).toBe('line 1\nline 2\nline 3')
  })

  it('extracts .text from content blocks and joins them', () => {
    expect(
      stringifyToolContent([
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' }
      ])
    ).toBe('first\nsecond')
  })

  it('JSON-stringifies non-text blocks in a mixed array', () => {
    const out = stringifyToolContent([{ type: 'text', text: 'ok' }, { type: 'image', data: 'xyz' }])
    expect(out).toBe('ok\n{"type":"image","data":"xyz"}')
  })

  it('stringifies a bare object', () => {
    expect(stringifyToolContent({ a: 1 })).toBe('{"a":1}')
  })

  it('maps null/undefined to empty string', () => {
    expect(stringifyToolContent(null)).toBe('')
    expect(stringifyToolContent(undefined)).toBe('')
  })
})
