import { describe, it, expect } from 'vitest'
import { parseConflicts, applyChoice } from './conflict'

const CONFLICT = [
  'line 1',
  '<<<<<<< HEAD',
  'our change',
  '=======',
  'their change',
  '>>>>>>> bearcode/x',
  'line 2'
].join('\n')

describe('parseConflicts', () => {
  it('detects and splits ours/theirs', () => {
    const r = parseConflicts(CONFLICT)
    expect(r.hasConflicts).toBe(true)
    expect(r.hunks[0].ours).toBe('our change')
    expect(r.hunks[0].theirs).toBe('their change')
  })
  it('reports no conflicts for clean text', () => {
    expect(parseConflicts('a\nb\n').hasConflicts).toBe(false)
  })
})

describe('applyChoice', () => {
  it('accepts ours across all hunks', () => {
    expect(applyChoice(CONFLICT, 'ours')).toBe('line 1\nour change\nline 2')
  })
  it('accepts theirs across all hunks', () => {
    expect(applyChoice(CONFLICT, 'theirs')).toBe('line 1\ntheir change\nline 2')
  })
})
