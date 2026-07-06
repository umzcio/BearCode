import { describe, it, expect, vi } from 'vitest'

// classify.ts imports sniffImageMime from ./ingest, which imports electron.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/bearcode-test' } }))

import { classifyPicked, isUtf8Clean } from './classify'

// Minimal ZIP local-file-header prefix ("PK\x03\x04") + a plaintext entry path.
// docx/xlsx are OOXML zips; local headers store the entry path in plaintext, so
// a substring peek disambiguates without a zip parser.
function zipWith(entryPath: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]),
    Buffer.from('....'),
    Buffer.from(entryPath, 'ascii'),
    Buffer.from('payload')
  ])
}

describe('classifyPicked', () => {
  it('classifies a PNG as image', () => {
    expect(classifyPicked(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]), 'x.png')).toEqual({
      kind: 'image',
      mime: 'image/png'
    })
  })

  it('classifies a %PDF- stream as pdf regardless of extension', () => {
    expect(classifyPicked(Buffer.from('%PDF-1.7\n...'), 'renamed.png')).toEqual({
      kind: 'pdf',
      mime: 'application/pdf'
    })
  })

  it('classifies a docx zip (word/document.xml) as office', () => {
    expect(classifyPicked(zipWith('word/document.xml'), 'a.docx')).toEqual({
      kind: 'office',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    })
  })

  it('classifies an xlsx zip (xl/workbook.xml) as office', () => {
    expect(classifyPicked(zipWith('xl/workbook.xml'), 'a.xlsx')).toEqual({
      kind: 'office',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    })
  })

  it('rejects a generic (non-OOXML) zip', () => {
    expect(classifyPicked(zipWith('random/file.bin'), 'a.zip')).toBeNull()
  })

  it('classifies a clean-UTF-8 .ts file as text', () => {
    expect(classifyPicked(Buffer.from('export const x = 1\n', 'utf8'), 'a.ts')).toEqual({
      kind: 'text',
      mime: 'text/plain'
    })
  })

  it('rejects a binary masquerading under a text extension (NUL byte)', () => {
    expect(classifyPicked(Buffer.from([0x00, 0x01, 0x02, 0x03]), 'evil.ts')).toBeNull()
  })

  it('rejects an unknown extension with no magic bytes', () => {
    expect(classifyPicked(Buffer.from('hello', 'utf8'), 'a.bin')).toBeNull()
  })
})

describe('isUtf8Clean', () => {
  it('accepts valid UTF-8 without NUL', () => {
    expect(isUtf8Clean(Buffer.from('héllo\nworld', 'utf8'))).toBe(true)
  })
  it('rejects a NUL byte', () => {
    expect(isUtf8Clean(Buffer.from([0x61, 0x00, 0x62]))).toBe(false)
  })
  it('rejects invalid UTF-8', () => {
    expect(isUtf8Clean(Buffer.from([0xff, 0xfe, 0xfd]))).toBe(false)
  })
})
