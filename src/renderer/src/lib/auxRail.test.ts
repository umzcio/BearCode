import { describe, it, expect } from 'vitest'
import type { ArtifactStatus, Event } from '@shared/types'
import { deriveRailEntries, versionsOfType } from './auxRail'

const art = (id: string, version: number, status: ArtifactStatus, type = 'plan'): Event =>
  ({
    type: 'artifact',
    id: `ev-${id}`,
    artifactId: id,
    artifactType: type,
    version,
    title: 'T',
    status,
    body: 'b'
  }) as Event
const diff = (diffId: string, fileCount: number): Event =>
  ({
    type: 'file_diff',
    id: `ev-${diffId}`,
    diffId,
    files: Array.from({ length: fileCount }, (_, i) => ({
      path: `f${i}.ts`,
      additions: 1,
      deletions: 0,
      status: 'modified'
    }))
  }) as Event
const noise: Event[] = [
  { type: 'user_message', id: 'u1', text: 'hi' } as Event,
  { type: 'assistant_text', id: 'a1', text: 'ok' } as Event
]

describe('deriveRailEntries', () => {
  it('lists artifacts and diff groups newest first, ignoring other events', () => {
    const events = [
      ...noise,
      art('p1', 1, 'approved'),
      diff('d1', 4),
      art('w1', 1, 'final', 'walkthrough')
    ]
    const kinds = deriveRailEntries(events).map((e) =>
      e.kind === 'artifact' ? e.event.artifactId : e.event.diffId
    )
    expect(kinds).toEqual(['w1', 'd1', 'p1'])
  })
  it('collapses superseded plans out of the rail (version history owns them)', () => {
    const events = [art('p1', 1, 'superseded'), art('p2', 2, 'pending-review')]
    const rail = deriveRailEntries(events)
    expect(rail).toHaveLength(1)
    expect(rail[0].kind === 'artifact' && rail[0].event.artifactId).toBe('p2')
  })
  it('keeps separate entries for non-superseded same-type artifacts (independent plans, not a chain)', () => {
    const events = [art('p1', 1, 'approved'), art('p2', 2, 'approved')]
    expect(deriveRailEntries(events)).toHaveLength(2)
  })
  it('returns [] for a conversation with no deliverables', () => {
    expect(deriveRailEntries(noise)).toEqual([])
  })
})

describe('versionsOfType', () => {
  it('returns all versions of the type ascending, superseded INCLUDED', () => {
    const events = [
      art('w1', 1, 'final', 'walkthrough'),
      art('p2', 2, 'superseded'),
      art('p3', 3, 'approved'),
      art('p1', 1, 'superseded')
    ]
    expect(versionsOfType(events, 'plan').map((a) => a.artifactId)).toEqual(['p1', 'p2', 'p3'])
    expect(versionsOfType(events, 'walkthrough').map((a) => a.artifactId)).toEqual(['w1'])
  })
})
