import { describe, it, expect, vi, beforeEach } from 'vitest'

// ingest.ts imports electron `app`; stub it so importing the pure helpers does
// not require a running Electron app.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/bearcode-test' } }))

// Drive ingest without touching disk. The path helpers are pure; only the reads
// and writes are mocked. `sizes` lets a test report a statSync size that
// disagrees with (or exists independent of) `files`, so the size-cap-before-
// read test below can prove readFileSync is never reached for an oversize
// path -- if it WERE reached, the mocked readFileSync throws ENOENT for a
// path absent from `files`, which is a different, distinguishable error.
const files: Record<string, Buffer> = {}
const sizes: Record<string, number> = {}
vi.mock('fs', () => ({
  existsSync: () => true,
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn((p: string, data: Buffer | string) => {
    files[p as string] = Buffer.isBuffer(data) ? data : Buffer.from(data)
  }),
  readFileSync: vi.fn((p: string) => {
    if (files[p as string]) return files[p as string]
    throw new Error('ENOENT')
  }),
  statSync: vi.fn((p: string) => {
    if (p in sizes) return { size: sizes[p as string] }
    if (files[p as string]) return { size: files[p as string].length }
    throw new Error('ENOENT')
  })
}))

vi.mock('./office', () => ({
  runOfficeExtraction: vi.fn(async () => ({
    text: 'DOCX BODY',
    truncated: false,
    notice: null,
    badge: 'DOCX'
  })),
  runPdfExtraction: vi.fn(async () => ({
    text: 'PDF BODY',
    truncated: false,
    notice: null,
    badge: 'PDF · 1 pp'
  }))
}))

import { readFileSync as mockedReadFileSync } from 'fs'
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

describe('size cap enforced BEFORE any read (resource-exhaustion guard)', () => {
  beforeEach(() => {
    for (const k of Object.keys(files)) delete files[k]
    for (const k of Object.keys(sizes)) delete sizes[k]
    vi.mocked(mockedReadFileSync).mockClear()
  })

  it('rejects an oversize file via statSync WITHOUT ever calling readFileSync on it', async () => {
    // Deliberately absent from `files`: if the implementation regressed to
    // reading before checking the stat-reported size, the mocked
    // readFileSync would throw ENOENT for this path instead of the cap error
    // asserted below, so this also proves the ordering, not just the call.
    sizes['/huge.bin'] = MAX_ATTACHMENT_BYTES + 1
    const { picked, errors } = await ingestPickedFiles('conv1', ['/huge.bin'], 0)
    expect(picked).toEqual([])
    expect(errors[0]).toMatch(/larger than 10 MB/)
    expect(mockedReadFileSync).not.toHaveBeenCalledWith('/huge.bin')
  })

  it('still reads and picks a file at/under the cap', async () => {
    sizes['/ok.png'] = MAX_ATTACHMENT_BYTES
    files['/ok.png'] = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0])
    const { picked, errors } = await ingestPickedFiles('conv1', ['/ok.png'], 0)
    expect(errors).toEqual([])
    expect(picked[0].ref.kind).toBe('image')
    expect(mockedReadFileSync).toHaveBeenCalledWith('/ok.png')
  })
})

describe('readAttachmentSidecar', () => {
  it('rejects a traversal conversationId', () => {
    expect(() => readAttachmentSidecar('../etc', 'abc')).toThrow(/conversationId/)
  })
})
