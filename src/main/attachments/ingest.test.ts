import { describe, it, expect, vi } from 'vitest'

// ingest.ts imports electron `app`; stub it so importing the pure helpers does
// not require a running Electron app.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/bearcode-test' } }))

import {
  sniffImageMime,
  attachmentPath,
  checkPickLimits,
  MAX_ATTACHMENT_BYTES,
  ingestPickedFiles,
  readAttachmentBase64
} from './ingest'

describe('sniffImageMime', () => {
  it('detects PNG from magic bytes', () => {
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe('image/png')
  })
  it('detects JPEG', () => {
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
  })
  it('detects GIF', () => {
    expect(sniffImageMime(Buffer.from('GIF89a'))).toBe('image/gif')
  })
  it('detects WEBP (RIFF....WEBP)', () => {
    const buf = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')])
    expect(sniffImageMime(buf)).toBe('image/webp')
  })
  it('rejects a PDF (sniffs by bytes, not extension)', () => {
    expect(sniffImageMime(Buffer.from('%PDF-1.7'))).toBeNull()
  })
  it('rejects a too-short buffer', () => {
    expect(sniffImageMime(Buffer.from([0x89]))).toBeNull()
  })
})

describe('attachmentPath', () => {
  it('joins userData/attachments/<convId>/<id>', () => {
    expect(attachmentPath('/data', 'conv1', 'abc')).toBe('/data/attachments/conv1/abc')
  })
})

describe('checkPickLimits', () => {
  it('accepts a small file below the count cap', () => {
    expect(checkPickLimits(0, 1024)).toBeNull()
  })
  it('refuses at the 5-attachment cap', () => {
    expect(checkPickLimits(5, 1024)).toMatch(/at most 5/)
  })
  it('refuses an oversize file', () => {
    expect(checkPickLimits(0, MAX_ATTACHMENT_BYTES + 1)).toMatch(/larger than 10 MB/)
  })
})

// SECURITY: conversationId is a renderer-supplied path segment used to build
// userData/attachments/<convId>/<id>; it must be validated BEFORE any
// mkdir/write/read. These throw synchronously on the invalid grammar, before
// touching the filesystem, so no fs mocking is needed to observe the guard.
describe('conversationId path-safety guard', () => {
  it('ingestPickedFiles rejects a traversal conversationId', () => {
    expect(() => ingestPickedFiles('../etc', [], 0)).toThrow(/conversationId/)
    expect(() => ingestPickedFiles('a/b', [], 0)).toThrow(/conversationId/)
    expect(() => ingestPickedFiles('a.b', [], 0)).toThrow(/conversationId/)
  })

  it('readAttachmentBase64 rejects a traversal conversationId', () => {
    expect(() => readAttachmentBase64('../etc', 'abc')).toThrow(/conversationId/)
    expect(() => readAttachmentBase64('a/b', 'abc')).toThrow(/conversationId/)
  })

  it('accepts a well-formed conversationId shape (no throw from the guard itself)', () => {
    expect(() => readAttachmentBase64('conv-1_ABC', 'abc')).not.toThrow()
  })
})
