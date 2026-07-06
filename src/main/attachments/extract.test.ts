import { describe, it, expect, vi, beforeEach } from 'vitest'

// unpdf is pure-JS but heavy; mock it so the cap/notice logic is what we test.
const extractTextMock = vi.fn()
const getDocumentProxyMock = vi.fn(async (...args: unknown[]) => ({
  __data: args[0],
  __opts: args[1]
}))
vi.mock('unpdf', () => ({
  extractText: (...args: unknown[]) => extractTextMock(...args),
  getDocumentProxy: (...args: unknown[]) => getDocumentProxyMock(...args)
}))

import {
  capText,
  extractTextLane,
  extractPdf,
  MAX_INLINE_TEXT_BYTES_PER_FILE,
  TRUNCATE_NOTICE
} from './extract'

beforeEach(() => {
  extractTextMock.mockReset()
  getDocumentProxyMock.mockClear()
})

describe('capText', () => {
  it('passes text under the cap through untouched', () => {
    expect(capText('hello')).toEqual({ text: 'hello', truncated: false })
  })
  it('truncates by byte length and flags it', () => {
    const big = 'x'.repeat(MAX_INLINE_TEXT_BYTES_PER_FILE + 100)
    const out = capText(big)
    expect(out.truncated).toBe(true)
    expect(Buffer.byteLength(out.text, 'utf8')).toBeLessThanOrEqual(MAX_INLINE_TEXT_BYTES_PER_FILE)
  })
})

describe('extractTextLane', () => {
  it('decodes UTF-8 bytes with a TXT badge', () => {
    const out = extractTextLane(Buffer.from('const a = 1\n', 'utf8'))
    expect(out.text).toBe('const a = 1\n')
    expect(out.truncated).toBe(false)
    expect(out.badge).toMatch(/KB|B/)
    expect(out.notice).toBeNull()
  })
  it('flags truncation with the notice', () => {
    const out = extractTextLane(Buffer.from('y'.repeat(MAX_INLINE_TEXT_BYTES_PER_FILE + 50), 'utf8'))
    expect(out.truncated).toBe(true)
    expect(out.notice).toBe(TRUNCATE_NOTICE)
  })
})

describe('extractPdf', () => {
  it('joins page text and reports a page-count badge; passes isEvalSupported:false', async () => {
    extractTextMock.mockResolvedValue({ totalPages: 3, text: 'page text here' })
    const out = await extractPdf(Buffer.from('%PDF-1.7'))
    expect(out.text).toBe('page text here')
    expect(out.badge).toMatch(/3 pp/)
    expect(out.notice).toBeNull()
    // Hardening: getDocumentProxy must receive isEvalSupported:false.
    expect(getDocumentProxyMock).toHaveBeenCalledWith(expect.anything(), { isEvalSupported: false })
  })

  it('emits a "no extractable text" notice for an image-only PDF', async () => {
    extractTextMock.mockResolvedValue({ totalPages: 2, text: '   \n  ' })
    const out = await extractPdf(Buffer.from('%PDF-1.7'))
    expect(out.notice).toMatch(/no extractable text/i)
  })

  it('fails soft (empty + notice) if the parser throws', async () => {
    extractTextMock.mockRejectedValue(new Error('bad pdf'))
    const out = await extractPdf(Buffer.from('%PDF-1.7'))
    expect(out.text).toBe('')
    expect(out.notice).toMatch(/could not/i)
  })
})
