import { describe, it, expect } from 'vitest'
import { previewClassify } from './classify'

describe('previewClassify', () => {
  it('images by extension', () => {
    expect(previewClassify('/w/a.png').kind).toBe('image')
    expect(previewClassify('/w/a.JPG').kind).toBe('image')
  })
  it('pdf', () => expect(previewClassify('/w/r.pdf').kind).toBe('pdf'))
  it('office docx/xlsx with a mime', () => {
    const d = previewClassify('/w/r.docx')
    expect(d.kind).toBe('office')
    expect(d.mime).toMatch(/word/)
    const x = previewClassify('/w/r.xlsx')
    expect(x.kind).toBe('office')
    expect(x.mime).toMatch(/sheet/)
  })
  it('everything else is text', () => {
    expect(previewClassify('/w/index.html').kind).toBe('text')
    expect(previewClassify('/w/app.ts').kind).toBe('text')
    expect(previewClassify('/w/notes').kind).toBe('text')
  })
})
