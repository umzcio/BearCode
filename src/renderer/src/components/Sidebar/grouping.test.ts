import { describe, it, expect } from 'vitest'
import { groupConversations } from './grouping'

const proj = (id: string, name: string, updatedAt = 0) => ({
  id, name, color: null, createdAt: 0, updatedAt
})
const c = (id: string, projectId: string | null, projectLabel: string) => ({
  id, projectId, projectLabel, updatedAt: 0
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
