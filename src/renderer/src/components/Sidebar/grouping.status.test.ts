import { describe, it, expect } from 'vitest'
import { statusBucket, groupConversations } from './grouping'

describe('statusBucket', () => {
  it('maps run states to Active/Idle/Error', () => {
    expect(statusBucket('running')).toBe('active')
    expect(statusBucket('awaiting-approval')).toBe('active')
    expect(statusBucket('done')).toBe('idle')
    expect(statusBucket('cancelled')).toBe('idle')
    expect(statusBucket('idle')).toBe('idle')
    expect(statusBucket('error')).toBe('error')
  })
})

describe('groupConversations by status + environment', () => {
  const convos = {
    a: mk('a', { runState: 'running' }),
    b: mk('b', { runState: 'done' }),
    c: mk('c', { runState: 'error', environment: 'worktree' })
  }
  function mk(id: string, over: Partial<Record<string, unknown>>): Record<string, unknown> {
    return {
      id,
      projectPath: '/p',
      projectLabel: 'p',
      title: id,
      updatedAt: 1,
      createdAt: 1,
      pinned: false,
      archived: false,
      runState: 'idle',
      environment: 'local',
      worktrees: [],
      ...over
    }
  }
  it('buckets by status in Active/Idle/Error order', () => {
    const g = groupConversations(['a', 'b', 'c'], convos as never, {
      groupBy: 'status',
      sort: 'updated',
      showArchived: false
    })
    expect(g.map((x) => (x.kind === 'status' ? x.bucket : x.kind))).toEqual([
      'active',
      'idle',
      'error'
    ])
  })
  it('buckets by environment', () => {
    const g = groupConversations(['a', 'c'], convos as never, {
      groupBy: 'environment',
      sort: 'updated',
      showArchived: false
    })
    const envs = g.map((x) => (x.kind === 'environment' ? x.env : x.kind))
    expect(envs).toContain('local')
    expect(envs).toContain('worktree')
  })
})
