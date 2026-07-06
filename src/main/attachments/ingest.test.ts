import { describe, it, expect, vi, beforeEach } from 'vitest'

// ingest.ts imports electron `app`; stub it so importing the pure helpers does
// not require a running Electron app.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/bearcode-test' } }))

// Drive ingest without touching disk. The path helpers are pure; only the reads
// and writes are mocked.
const files: Record<string, Buffer> = {}
vi.mock('fs', () => ({
  existsSync: () => true,
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn((p: string, data: Buffer | string) => {
    files[p as string] = Buffer.isBuffer(data) ? data : Buffer.from(data)
  }),
  readFileSync: vi.fn((p: string) => {
    if (files[p as string]) return files[p as string]
    throw new Error('ENOENT')
  })
}))

vi.mock('./office', () => ({
  runOfficeExtraction: vi.fn(async () => ({
    text: 'DOCX BODY',
    truncated: false,
    notice: null,
    badge: 'DOCX'
  }))
}))

import {
  sniffImageMime,
  attachmentPath,
  checkPickLimits,
  MAX_ATTACHMENT_BYTES,
  ingestPickedFiles,
  readAttachmentBase64,
  readAttachmentSidecar
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
  it('ingestPickedFiles rejects a traversal conversationId', async () => {
    await expect(ingestPickedFiles('../etc', [], 0)).rejects.toThrow(/conversationId/)
    await expect(ingestPickedFiles('a/b', [], 0)).rejects.toThrow(/conversationId/)
    await expect(ingestPickedFiles('a.b', [], 0)).rejects.toThrow(/conversationId/)
  })

  it('readAttachmentBase64 rejects a traversal conversationId', () => {
    expect(() => readAttachmentBase64('../etc', 'abc')).toThrow(/conversationId/)
    expect(() => readAttachmentBase64('a/b', 'abc')).toThrow(/conversationId/)
  })

  it('accepts a well-formed conversationId shape (no throw from the guard itself)', () => {
    expect(() => readAttachmentBase64('conv-1_ABC', 'abc')).not.toThrow()
  })
})

describe('ingestPickedFiles lane routing', () => {
  beforeEach(() => {
    for (const k of Object.keys(files)) delete files[k]
  })

  it('routes an image to kind image with a preview and NO sidecar', async () => {
    files['/img.png'] = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0])
    const { picked, errors } = await ingestPickedFiles('conv1', ['/img.png'], 0)
    expect(errors).toEqual([])
    expect(picked[0].ref.kind).toBe('image')
    expect(picked[0].previewDataUrl).toMatch(/^data:image\/png;base64,/)
  })

  it('routes a text file to kind text and writes a capped sidecar', async () => {
    files['/a.ts'] = Buffer.from('export const x = 1\n', 'utf8')
    const { picked } = await ingestPickedFiles('conv1', ['/a.ts'], 0)
    expect(picked[0].ref.kind).toBe('text')
    expect(picked[0].previewDataUrl).toBe('')
    const side = readAttachmentSidecar('conv1', picked[0].ref.id)
    expect(side).toBe('export const x = 1\n')
  })

  it('routes a docx to kind office via the (mocked) worker and sidecars its text', async () => {
    // "PK\x03\x04" + word/document.xml peek marks it docx.
    files['/a.docx'] = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('....word/document.xml....')
    ])
    const { picked } = await ingestPickedFiles('conv1', ['/a.docx'], 0)
    expect(picked[0].ref.kind).toBe('office')
    expect(readAttachmentSidecar('conv1', picked[0].ref.id)).toBe('DOCX BODY')
  })

  it('rejects an unsupported file with an error and no pick', async () => {
    files['/x.bin'] = Buffer.from([0x00, 0x01, 0x02])
    const { picked, errors } = await ingestPickedFiles('conv1', ['/x.bin'], 0)
    expect(picked).toEqual([])
    expect(errors[0]).toMatch(/not a supported/i)
  })

  it('enforces the 5-file cap across a multi-select', async () => {
    files['/i.png'] = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0])
    const { errors } = await ingestPickedFiles('conv1', ['/i.png'], 5)
    expect(errors[0]).toMatch(/at most 5/)
  })
})

describe('readAttachmentSidecar', () => {
  it('rejects a traversal conversationId', () => {
    expect(() => readAttachmentSidecar('../etc', 'abc')).toThrow(/conversationId/)
  })
})
