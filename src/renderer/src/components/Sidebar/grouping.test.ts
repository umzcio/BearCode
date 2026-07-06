import { describe, it, expect } from 'vitest'
import { groupConversations } from './grouping'

const proj = (id: string, name: string, updatedAt = 0) => ({
  id, name, color: null, createdAt: 0, updatedAt
})
const c = (id: string, projectId: string | null, projectLabel: string, extra: { title?: string; updatedAt?: number; createdAt?: number } = {}) => ({
  id, projectId, projectLabel,
  title: extra.title ?? id, updatedAt: extra.updatedAt ?? 0, createdAt: extra.createdAt ?? 0
})

describe('groupConversations', () => {
  it('project groups come first (by project updatedAt desc), then folder groups for unassigned', () => {
    const convos = {
      a: c('a', 'p1', 'repoX'),
      b: c('b', null, 'repoX'),
      d: c('d', 'p2', 'repoY')
    }
    const groups = groupConversations(['a', 'b', 'd'], convos, [proj('p1', 'Alpha', 1), proj('p2', 'Beta', 2)])
    expect(groups.map((g) => g.kind + ':' + g.label)).toEqual([
      'project:Beta',   // p2 updatedAt 2 > p1
      'project:Alpha',
      'folder:repoX'    // unassigned 'b'
    ])
    expect(groups[0].convoIds).toEqual(['d'])
    expect(groups[2].convoIds).toEqual(['b'])
  })
  it('an empty project still appears (no conversations)', () => {
    const groups = groupConversations([], {}, [proj('p1', 'Alpha')])
    expect(groups).toEqual([{ kind: 'project', projectId: 'p1', label: 'Alpha', convoIds: [] }])
  })
  it('all-unassigned falls back to folder grouping (today behavior)', () => {
    const convos = { a: c('a', null, 'repoX'), b: c('b', null, 'repoX') }
    const groups = groupConversations(['a', 'b'], convos, [])
    expect(groups).toEqual([{ kind: 'folder', label: 'repoX', convoIds: ['a', 'b'] }])
  })
})

describe('groupConversations opts', () => {
  it('groupBy none returns a single all-group', () => {
    const convos = { a: c('a', 'p1', 'r'), b: c('b', null, 'r') }
    const g = groupConversations(['a', 'b'], convos, [{ id: 'p1', name: 'P', color: null, createdAt: 0, updatedAt: 0 }], { groupBy: 'none', sort: 'updated' })
    expect(g).toHaveLength(1)
    expect(g[0].kind).toBe('all')
    expect(g[0].convoIds.sort()).toEqual(['a', 'b'])
  })
  it('sort alpha orders by title within a group', () => {
    const convos = { a: c('a', null, 'r', { title: 'Zed' }), b: c('b', null, 'r', { title: 'Ada' }) }
    const g = groupConversations(['a', 'b'], convos, [], { groupBy: 'none', sort: 'alpha' })
    expect(g[0].convoIds).toEqual(['b', 'a']) // Ada before Zed
  })
  it('sort created orders by createdAt desc', () => {
    const convos = { a: c('a', null, 'r', { createdAt: 1 }), b: c('b', null, 'r', { createdAt: 9 }) }
    const g = groupConversations(['a', 'b'], convos, [], { groupBy: 'none', sort: 'created' })
    expect(g[0].convoIds).toEqual(['b', 'a'])
  })
  it('default opts (project/updated) preserve today behavior', () => {
    const convos = { a: c('a', null, 'repoX') }
    const g = groupConversations(['a'], convos, [])
    expect(g).toEqual([{ kind: 'folder', label: 'repoX', convoIds: ['a'] }])
  })
})
