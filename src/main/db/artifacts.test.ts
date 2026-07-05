// Pins the artifacts row -> Artifact mapping (toArtifact), the seam the
// artifacts store's mocked '../db' module skips entirely -- the same class of
// gap that shipped R1 in Bb3 (see db/rules.test.ts's doc comment). The mapping
// is tested pure, on hand-built row objects: better-sqlite3's native binding
// is compiled for Electron's ABI and cannot load under plain-Node vitest, so
// both 'electron' and 'better-sqlite3' are mocked and no database is opened.
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/nonexistent') }
}))
vi.mock('better-sqlite3', () => ({
  default: vi.fn()
}))

import { toArtifact, toArtifactComment, type ArtifactRow, type ArtifactCommentRow } from './index'

const row = (overrides: Partial<ArtifactRow> = {}): ArtifactRow => ({
  id: 'art-1',
  conversation_id: 'convo-1',
  type: 'plan',
  version: 1,
  title: 'Add dark mode',
  body: '# Plan\n\n1. Do the thing',
  status: 'pending-review',
  created_at: 1000,
  resolved_at: null,
  ...overrides
})

describe('toArtifact', () => {
  it('maps a plan row through verbatim', () => {
    expect(toArtifact(row())).toEqual({
      id: 'art-1',
      conversationId: 'convo-1',
      type: 'plan',
      version: 1,
      title: 'Add dark mode',
      body: '# Plan\n\n1. Do the thing',
      status: 'pending-review',
      createdAt: 1000,
      resolvedAt: null
    })
  })

  it('maps a resolved walkthrough row, keeping resolved_at', () => {
    const a = toArtifact(row({ type: 'walkthrough', status: 'final', resolved_at: 2000 }))
    expect(a?.type).toBe('walkthrough')
    expect(a?.status).toBe('final')
    expect(a?.resolvedAt).toBe(2000)
  })

  it('maps every status the writers produce', () => {
    for (const status of ['pending-review', 'approved', 'superseded', 'final'] as const) {
      expect(toArtifact(row({ status }))?.status).toBe(status)
    }
  })

  it('returns null and warns for an unknown type, never coercing (R1 posture)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(toArtifact(row({ type: 'diagram' }))).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('diagram')
    expect(warn.mock.calls[0][0]).toContain('art-1')
    warn.mockRestore()
  })

  it('returns null and warns for an unknown status', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(toArtifact(row({ status: 'rejected' }))).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

const commentRow = (overrides: Partial<ArtifactCommentRow> = {}): ArtifactCommentRow => ({
  id: 'c-1',
  artifact_id: 'art-1',
  quote: 'Step 2: rewrite the config',
  body: 'Do not touch the config; extend it instead.',
  created_at: 1000,
  sent_at: null,
  ...overrides
})

describe('toArtifactComment', () => {
  it('maps a draft comment row verbatim (sent_at NULL stays null)', () => {
    expect(toArtifactComment(commentRow())).toEqual({
      id: 'c-1',
      artifactId: 'art-1',
      quote: 'Step 2: rewrite the config',
      body: 'Do not touch the config; extend it instead.',
      createdAt: 1000,
      sentAt: null
    })
  })
  it('maps a sent, quoteless comment', () => {
    const c = toArtifactComment(commentRow({ quote: null, sent_at: 2000 }))
    expect(c.quote).toBeNull()
    expect(c.sentAt).toBe(2000)
  })
})
