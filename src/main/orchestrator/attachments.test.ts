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

  it('accepts a well-formed ref and drops unknown fields (kind defaults to image)', () => {
    const out = assertValidAttachments([
      { id: 'abc-123_XYZ', name: 'shot.png', mime: 'image/png', bytes: 'nope' }
    ])
    expect(out).toEqual([{ id: 'abc-123_XYZ', name: 'shot.png', mime: 'image/png', kind: 'image' }])
  })

  it('rejects a traversal id', () => {
    expect(() => assertValidAttachments([{ id: '../etc', name: 'x', mime: 'image/png' }])).toThrow(
      /attachment\.id/
    )
    expect(() => assertValidAttachments([{ id: 'a/b', name: 'x', mime: 'image/png' }])).toThrow()
    expect(() => assertValidAttachments([{ id: 'a.png', name: 'x', mime: 'image/png' }])).toThrow()
  })

  it('rejects a mime outside the widened allowlist (e.g. a zip)', () => {
    expect(() =>
      assertValidAttachments([{ id: 'a1', name: 'x.zip', mime: 'application/zip' }])
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

  it("defaults a missing kind to 'image' (back-compat)", () => {
    const out = assertValidAttachments([{ id: 'a1', name: 'x.png', mime: 'image/png' }])
    expect(out).toEqual([{ id: 'a1', name: 'x.png', mime: 'image/png', kind: 'image' }])
  })

  it('accepts a pdf ref with kind pdf', () => {
    const out = assertValidAttachments([
      { id: 'p1', name: 'doc.pdf', mime: 'application/pdf', kind: 'pdf' }
    ])
    expect(out).toEqual([{ id: 'p1', name: 'doc.pdf', mime: 'application/pdf', kind: 'pdf' }])
  })

  it('accepts a text ref with a text/* mime and kind text', () => {
    const out = assertValidAttachments([
      { id: 't1', name: 'a.ts', mime: 'text/plain', kind: 'text' }
    ])
    expect(out).toEqual([{ id: 't1', name: 'a.ts', mime: 'text/plain', kind: 'text' }])
  })

  it('accepts a docx ref with kind office', () => {
    const out = assertValidAttachments([
      {
        id: 'd1',
        name: 'a.docx',
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        kind: 'office'
      }
    ])
    expect(out[0].kind).toBe('office')
  })

  it('rejects an unknown kind', () => {
    expect(() =>
      assertValidAttachments([{ id: 'a1', name: 'x', mime: 'text/plain', kind: 'video' }])
    ).toThrow(/kind/)
  })

  it('rejects a mime outside the widened allowlist', () => {
    expect(() =>
      assertValidAttachments([{ id: 'a1', name: 'x', mime: 'application/zip', kind: 'office' }])
    ).toThrow(/mime/)
  })
})
