import { describe, it, expect, vi } from 'vitest'

// index.ts -> ./graph -> ../db/./checkpointer touch electron/sqlite at import;
// mock them so importing the module never opens a real database (Global
// Constraints; same block as graph.test.ts).
vi.mock('../db', () => ({
  appendEvent: vi.fn(),
  appendOrReplaceEvent: vi.fn(),
  dropDanglingApprovalRows: vi.fn(),
  dropDanglingCancel: vi.fn(),
  getConversationMeta: vi.fn(() => null),
  getEvents: vi.fn(() => []),
  listArtifactComments: vi.fn(() => []),
  markArtifactCommentsSent: vi.fn(),
  setActiveRules: vi.fn(),
  setPermissionMode: vi.fn()
}))

vi.mock('./checkpointer', () => ({
  getCheckpointer: () => ({ getTuple: vi.fn() }),
  pruneCheckpoints: vi.fn()
}))

import { assertValidAttachments } from './index'

describe('assertValidAttachments', () => {
  it('returns [] for null/undefined', () => {
    expect(assertValidAttachments(null)).toEqual([])
    expect(assertValidAttachments(undefined)).toEqual([])
  })

  it('accepts a well-formed ref and drops unknown fields', () => {
    const out = assertValidAttachments([
      { id: 'abc-123_XYZ', name: 'shot.png', mime: 'image/png', bytes: 'nope' }
    ])
    expect(out).toEqual([{ id: 'abc-123_XYZ', name: 'shot.png', mime: 'image/png' }])
  })

  it('rejects a traversal id', () => {
    expect(() => assertValidAttachments([{ id: '../etc', name: 'x', mime: 'image/png' }])).toThrow(
      /attachment\.id/
    )
    expect(() => assertValidAttachments([{ id: 'a/b', name: 'x', mime: 'image/png' }])).toThrow()
    expect(() => assertValidAttachments([{ id: 'a.png', name: 'x', mime: 'image/png' }])).toThrow()
  })

  it('rejects an unsupported mime (incl. pdf)', () => {
    expect(() =>
      assertValidAttachments([{ id: 'a1', name: 'x.pdf', mime: 'application/pdf' }])
    ).toThrow(/mime/)
  })

  it('rejects more than 5 attachments', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      id: `id${i}`,
      name: 'x.png',
      mime: 'image/png'
    }))
    expect(() => assertValidAttachments(many)).toThrow(/too many/)
  })

  it('rejects an empty or oversize name', () => {
    expect(() => assertValidAttachments([{ id: 'a1', name: '', mime: 'image/png' }])).toThrow(/name/)
  })
})
