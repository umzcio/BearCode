import { describe, it, expect } from 'vitest'
import { groupConversations } from './grouping'

type Convo = {
  id: string
  projectPath: string | null
  projectLabel: string
  title: string
  updatedAt: number
  createdAt: number
  pinned: boolean
  archived: boolean
}

const c = (
  id: string,
  projectPath: string | null,
  projectLabel: string,
  extra: {
    title?: string
    updatedAt?: number
    createdAt?: number
    pinned?: boolean
    archived?: boolean
  } = {}
): Convo => ({
  id,
  projectPath,
  projectLabel,
  title: extra.title ?? id,
  updatedAt: extra.updatedAt ?? 0,
  createdAt: extra.createdAt ?? 0,
  pinned: extra.pinned ?? false,
  archived: extra.archived ?? false
})

describe('groupConversations (folder = project)', () => {
  it('groups by full projectPath, in first-appearance order over `order`', () => {
    const convos = {
      a: c('a', '/repo/x', 'x'),
      b: c('b', '/repo/y', 'y'),
      d: c('d', '/repo/x', 'x')
    }
    const groups = groupConversations(['a', 'b', 'd'], convos)
    expect(groups.map((g) => (g.kind === 'folder' ? g.path : g.kind))).toEqual([
      '/repo/x',
      '/repo/y'
    ])
    expect(groups[0].convoIds).toEqual(['a', 'd'])
    expect(groups[1].convoIds).toEqual(['b'])
  })

  it('keeps same-basename folders at different paths separate', () => {
    const convos = { a: c('a', '/one/repo', 'repo'), b: c('b', '/two/repo', 'repo') }
    const groups = groupConversations(['a', 'b'], convos)
    expect(groups).toHaveLength(2)
    expect(groups.map((g) => (g.kind === 'folder' ? g.path : ''))).toEqual([
      '/one/repo',
      '/two/repo'
    ])
  })

  it('a null projectPath forms the "No folder" group (path null)', () => {
    const convos = { a: c('a', null, 'No folder'), b: c('b', null, 'No folder') }
    const groups = groupConversations(['a', 'b'], convos)
    expect(groups).toEqual([
      { kind: 'folder', path: null, label: 'No folder', convoIds: ['a', 'b'] }
    ])
  })
})

describe('groupConversations opts', () => {
  it('groupBy none returns a single all-group', () => {
    const convos = { a: c('a', '/r', 'r'), b: c('b', null, 'No folder') }
    const g = groupConversations(['a', 'b'], convos, {
      groupBy: 'none',
      sort: 'updated',
      showArchived: false
    })
    expect(g).toHaveLength(1)
    expect(g[0].kind).toBe('all')
    expect(g[0].convoIds.sort()).toEqual(['a', 'b'])
  })
  it('sort alpha orders by title within a group', () => {
    const convos = {
      a: c('a', null, 'r', { title: 'Zed' }),
      b: c('b', null, 'r', { title: 'Ada' })
    }
    const g = groupConversations(['a', 'b'], convos, {
      groupBy: 'none',
      sort: 'alpha',
      showArchived: false
    })
    expect(g[0].convoIds).toEqual(['b', 'a']) // Ada before Zed
  })
  it('sort created orders by createdAt desc', () => {
    const convos = {
      a: c('a', null, 'r', { createdAt: 1 }),
      b: c('b', null, 'r', { createdAt: 9 })
    }
    const g = groupConversations(['a', 'b'], convos, {
      groupBy: 'none',
      sort: 'created',
      showArchived: false
    })
    expect(g[0].convoIds).toEqual(['b', 'a'])
  })
  it('default opts (project/updated) group by path', () => {
    const convos = { a: c('a', '/repo/x', 'x') }
    const g = groupConversations(['a'], convos)
    expect(g).toEqual([{ kind: 'folder', path: '/repo/x', label: 'x', convoIds: ['a'] }])
  })
  it('an archived conversation appears in no group', () => {
    const convos = {
      a: c('a', '/repo/x', 'x', { archived: true }),
      b: c('b', '/repo/y', 'y')
    }
    const g = groupConversations(['a', 'b'], convos)
    expect(g).toEqual([{ kind: 'folder', path: '/repo/y', label: 'y', convoIds: ['b'] }])
  })
  it('a pinned conversation sorts before a more-recently-updated non-pinned one', () => {
    const convos = {
      a: c('a', '/r', 'r', { updatedAt: 1, pinned: true }),
      b: c('b', '/r', 'r', { updatedAt: 2 })
    }
    const g = groupConversations(['a', 'b'], convos, {
      groupBy: 'none',
      sort: 'updated',
      showArchived: false
    })
    expect(g[0].convoIds).toEqual(['a', 'b'])
  })
  it('showArchived false (default) excludes archived (groupBy none)', () => {
    const convos = { a: c('a', '/r', 'r'), b: c('b', '/r', 'r', { archived: true }) }
    const g = groupConversations(['a', 'b'], convos, {
      groupBy: 'none',
      sort: 'updated',
      showArchived: false
    })
    expect(g[0].convoIds).toEqual(['a'])
  })
  it('showArchived true includes archived (groupBy none)', () => {
    const convos = { a: c('a', '/r', 'r'), b: c('b', '/r', 'r', { archived: true }) }
    const g = groupConversations(['a', 'b'], convos, {
      groupBy: 'none',
      sort: 'updated',
      showArchived: true
    })
    expect(g[0].convoIds.sort()).toEqual(['a', 'b'])
  })
  it('showArchived false (default) excludes archived (groupBy project)', () => {
    const convos = { a: c('a', '/r', 'r'), b: c('b', '/r', 'r', { archived: true }) }
    const g = groupConversations(['a', 'b'], convos, {
      groupBy: 'project',
      sort: 'updated',
      showArchived: false
    })
    expect(g[0].convoIds).toEqual(['a'])
  })
  it('showArchived true includes archived (groupBy project)', () => {
    const convos = { a: c('a', '/r', 'r'), b: c('b', '/r', 'r', { archived: true }) }
    const g = groupConversations(['a', 'b'], convos, {
      groupBy: 'project',
      sort: 'updated',
      showArchived: true
    })
    expect(g[0].convoIds.sort()).toEqual(['a', 'b'])
  })
})
