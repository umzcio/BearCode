import { describe, it, expect } from 'vitest'
import { type Convo } from '../../state/store'
import { searchEntries } from './searchEntries'

const convo = (id: string, title: string, updatedAt: number): Convo => ({
  id,
  title,
  projectLabel: 'repo',
  projectId: null,
  updatedAt,
  createdAt: 0,
  pinned: false,
  archived: false,
  projectPath: null,
  modelRef: null,
  permissionMode: 'accept-edits' as const,
  effort: 'adaptive' as const,
  thinking: true,
  loaded: true,
  events: [],
  runState: 'idle' as const
})
const folder = (
  path: string,
  label: string,
  updatedAt: number
): { path: string; label: string; updatedAt: number } => ({ path, label, updatedAt })

describe('searchEntries (folder = project)', () => {
  it('empty query returns all, conversations then folders, by recency', () => {
    const out = searchEntries(
      '',
      [convo('c1', 'Alpha', 2), convo('c2', 'Beta', 5)],
      [folder('/repo/x', 'x', 9)]
    )
    expect(out.map((e) => e.kind + ':' + e.id)).toEqual([
      'conversation:c2',
      'conversation:c1',
      'project:/repo/x'
    ])
  })
  it('ranks prefix < substring < subsequence and drops non-matches', () => {
    const out = searchEntries(
      'ap',
      [convo('c1', 'apex', 1), convo('c2', 'grape', 1), convo('c3', 'xyz', 1)],
      []
    )
    expect(out.map((e) => e.id)).toEqual(['c1', 'c2']) // apex(prefix) < grape(substring); xyz dropped
  })
  it('matches folder labels too (kind project, id = path)', () => {
    const out = searchEntries('camp', [], [folder('/Users/zach/Campus', 'Campus', 1)])
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('project')
    expect(out[0].id).toBe('/Users/zach/Campus')
  })
  it('caps at 50 entries', () => {
    const many = Array.from({ length: 80 }, (_, i) => convo('c' + i, 'x', i))
    expect(searchEntries('', many, [])).toHaveLength(50)
  })
})
