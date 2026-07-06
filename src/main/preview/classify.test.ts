import { describe, it, expect } from 'vitest'
import { previewClassify } from './classify'

describe('previewClassify', () => {
  it('images by extension', () => {
    expect(previewClassify('/w/a.png').kind).toBe('image')
    expect(previewClassify('/w/a.JPG').kind).toBe('image')
  })
  it('svg', () => expect(previewClassify('/w/icon.svg').kind).toBe('svg'))
  it('pdf', () => expect(previewClassify('/w/r.pdf').kind).toBe('pdf'))
  it('docx', () => expect(previewClassify('/w/r.docx').kind).toBe('docx'))
  it('xlsx', () => expect(previewClassify('/w/r.xlsx').kind).toBe('xlsx'))
  it('markdown', () => {
    expect(previewClassify('/w/notes.md').kind).toBe('markdown')
    expect(previewClassify('/w/notes.markdown').kind).toBe('markdown')
  })
  it('csv', () => expect(previewClassify('/w/data.csv').kind).toBe('csv'))
  it('json', () => expect(previewClassify('/w/pkg.json').kind).toBe('json'))
  it('code with language', () => {
    const c = previewClassify('/w/app.ts')
    expect(c.kind).toBe('code')
    expect(c.language).toBe('typescript')
  })
  it('html', () => {
    expect(previewClassify('/w/index.html').kind).toBe('html')
    expect(previewClassify('/w/index.htm').kind).toBe('html')
  })
  it('everything else is text', () => {
    expect(previewClassify('/w/readme.txt').kind).toBe('text')
    expect(previewClassify('/w/notes').kind).toBe('text')
  })
})
