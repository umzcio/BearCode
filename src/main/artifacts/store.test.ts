import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Artifact } from '../../shared/types'

vi.mock('../db', () => ({
  insertArtifact: vi.fn(),
  getArtifact: vi.fn(() => null),
  listArtifacts: vi.fn(() => []),
  markPendingPlansSuperseded: vi.fn()
}))
vi.mock('../settings', () => ({
  getSettings: vi.fn(() => ({
    ollamaBaseUrl: '',
    defaultModelRef: null,
    defaultPermissionMode: 'accept-edits',
    disabledBuiltins: [] as string[],
    artifactReviewPolicy: 'request-review' as const
  }))
}))

import { getSettings } from '../settings'
import { getArtifact, insertArtifact, listArtifacts, markPendingPlansSuperseded } from '../db'
import { createPlanArtifact, createWalkthroughArtifact, nextArtifactVersion } from './store'

const art = (over: Partial<Artifact> = {}): Artifact => ({
  id: 'a-' + Math.random(),
  conversationId: 'convo',
  type: 'plan',
  version: 1,
  title: 'T',
  body: 'B',
  status: 'approved',
  createdAt: 1,
  resolvedAt: 1,
  ...over
})

const settingsWith = (policy: 'request-review' | 'always-proceed'): void => {
  vi.mocked(getSettings).mockReturnValue({
    ollamaBaseUrl: '',
    defaultModelRef: null,
    defaultPermissionMode: 'accept-edits',
    disabledBuiltins: [],
    artifactReviewPolicy: policy
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listArtifacts).mockReturnValue([])
  vi.mocked(getArtifact).mockReturnValue(null)
  settingsWith('request-review')
})

describe('nextArtifactVersion (pure)', () => {
  it('starts at 1 for an empty conversation', () => {
    expect(nextArtifactVersion([], 'plan')).toBe(1)
  })
  it('increments past the max version of the SAME type only', () => {
    const existing = [
      art({ type: 'plan', version: 3 }),
      art({ type: 'walkthrough', version: 7, status: 'final' })
    ]
    expect(nextArtifactVersion(existing, 'plan')).toBe(4)
    expect(nextArtifactVersion(existing, 'walkthrough')).toBe(8)
  })
})

describe('createPlanArtifact', () => {
  it("request-review policy records a 'pending-review' plan with no resolved_at", () => {
    const { artifact, policy } = createPlanArtifact('convo', 'Add dark mode', '# Plan')
    expect(policy).toBe('request-review')
    expect(artifact.status).toBe('pending-review')
    expect(artifact.resolvedAt).toBeNull()
    expect(artifact.type).toBe('plan')
    expect(artifact.version).toBe(1)
    expect(insertArtifact).toHaveBeenCalledTimes(1)
    expect(insertArtifact).toHaveBeenCalledWith(artifact)
  })
  it("always-proceed policy records the plan 'approved' and resolved immediately", () => {
    settingsWith('always-proceed')
    const { artifact, policy } = createPlanArtifact('convo', 'Add dark mode', '# Plan')
    expect(policy).toBe('always-proceed')
    expect(artifact.status).toBe('approved')
    expect(artifact.resolvedAt).not.toBeNull()
  })
  it('policy is read live at each call (a Settings flip applies to the next submit)', () => {
    expect(createPlanArtifact('convo', 'v1', 'b').artifact.status).toBe('pending-review')
    settingsWith('always-proceed')
    expect(createPlanArtifact('convo', 'v2', 'b').artifact.status).toBe('approved')
  })
  it('versions increment from the conversation history', () => {
    vi.mocked(listArtifacts).mockReturnValue([
      art({ type: 'plan', version: 2, status: 'superseded' }),
      art({ type: 'walkthrough', version: 5, status: 'final' })
    ])
    expect(createPlanArtifact('convo', 'T', 'B').artifact.version).toBe(3)
  })
  it('supersedes still-pending prior plans BEFORE inserting the new row', () => {
    createPlanArtifact('convo', 'T', 'B')
    expect(markPendingPlansSuperseded).toHaveBeenCalledTimes(1)
    expect(vi.mocked(markPendingPlansSuperseded).mock.calls[0][0]).toBe('convo')
    expect(vi.mocked(markPendingPlansSuperseded).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(insertArtifact).mock.invocationCallOrder[0]
    )
  })
})

describe('createWalkthroughArtifact', () => {
  it("is born 'final' regardless of the review policy and never supersedes plans", () => {
    const a = createWalkthroughArtifact('convo', 'What changed', '## Summary')
    expect(a.type).toBe('walkthrough')
    expect(a.status).toBe('final')
    expect(a.resolvedAt).not.toBeNull()
    expect(a.version).toBe(1)
    expect(markPendingPlansSuperseded).not.toHaveBeenCalled()
    expect(insertArtifact).toHaveBeenCalledWith(a)
  })
  it('walkthrough versions count independently of plan versions', () => {
    vi.mocked(listArtifacts).mockReturnValue([art({ type: 'plan', version: 4 })])
    expect(createWalkthroughArtifact('convo', 'T', 'B').version).toBe(1)
  })
})

describe('replay idempotency (crash-rehydration re-executes completed submit tools)', () => {
  it('a second createPlanArtifact with the same id returns the existing row: no insert, no supersede, no version bump', () => {
    const existing = art({
      id: 'convo:tc1:artifact',
      status: 'pending-review',
      version: 1,
      resolvedAt: null
    })
    vi.mocked(getArtifact).mockReturnValue(existing)
    const { artifact, policy } = createPlanArtifact('convo', 'T', 'B', 'convo:tc1:artifact')
    expect(artifact).toBe(existing)
    expect(policy).toBe('request-review')
    expect(insertArtifact).not.toHaveBeenCalled()
    expect(markPendingPlansSuperseded).not.toHaveBeenCalled()
    expect(listArtifacts).not.toHaveBeenCalled()
  })
  it('the replay path reports the policy the ORIGINAL submission ran under, from the recorded status', () => {
    // Live setting says request-review NOW, but the recorded row was approved:
    // the replayed tool must return the approval copy the original run earned.
    settingsWith('request-review')
    vi.mocked(getArtifact).mockReturnValue(art({ id: 'x', status: 'approved' }))
    expect(createPlanArtifact('convo', 'T', 'B', 'x').policy).toBe('always-proceed')
  })
  it('a second createWalkthroughArtifact with the same id returns the existing row without inserting', () => {
    const existing = art({ id: 'w1', type: 'walkthrough', status: 'final' })
    vi.mocked(getArtifact).mockReturnValue(existing)
    expect(createWalkthroughArtifact('convo', 'T', 'B', 'w1')).toBe(existing)
    expect(insertArtifact).not.toHaveBeenCalled()
  })
})
