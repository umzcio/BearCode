import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) },
  app: { getPath: vi.fn(() => '/nonexistent') },
  BrowserWindow: {},
  dialog: {},
  shell: {}
}))

// vi.mock factories are hoisted above regular top-level const/let declarations,
// so any vi.fn() referenced directly in a factory's returned object must be
// created via vi.hoisted() (which hoists together, in source order) rather
// than a plain const — otherwise it's a TDZ ReferenceError at import time.
const {
  filePathFor,
  statSync,
  readFileSync,
  runPdfExtraction,
  runOfficeExtraction,
  runOfficeHtml,
  runOfficeRows,
  extractTextLane
} = vi.hoisted(() => ({
  filePathFor: vi.fn(),
  statSync: vi.fn(),
  readFileSync: vi.fn(),
  runPdfExtraction: vi.fn(),
  runOfficeExtraction: vi.fn(),
  runOfficeHtml: vi.fn(),
  runOfficeRows: vi.fn(),
  extractTextLane: vi.fn()
}))
vi.mock('./diffs', () => ({ filePathFor, getDiff: vi.fn(), revertFile: vi.fn() }))
vi.mock('fs', () => ({ statSync, readFileSync }))
vi.mock('./attachments/office', () => ({
  runPdfExtraction,
  runOfficeExtraction,
  runOfficeHtml,
  runOfficeRows
}))
vi.mock('./attachments/extract', () => ({ extractTextLane }))

import { registerIpc } from './ipc'

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  registerIpc()
})

describe('diffs:preview IPC', () => {
  it('a .txt file goes through extractTextLane', async () => {
    filePathFor.mockReturnValue('/ws/notes.txt')
    statSync.mockReturnValue({ size: 10 })
    readFileSync.mockReturnValue(Buffer.from('hello'))
    extractTextLane.mockReturnValue({ text: 'hello', truncated: false })

    const result = await handlers.get('bearcode:diffs:preview')!({}, 'f1')

    expect(extractTextLane).toHaveBeenCalledWith(Buffer.from('hello'))
    expect(result).toEqual({ kind: 'text', text: 'hello', truncated: false })
  })

  it('a .png file becomes a base64 data URL', async () => {
    filePathFor.mockReturnValue('/ws/pic.png')
    statSync.mockReturnValue({ size: 10 })
    readFileSync.mockReturnValue(Buffer.from('imgbytes'))

    const result = await handlers.get('bearcode:diffs:preview')!({}, 'f2')

    expect(result).toMatchObject({ kind: 'image' })
    expect((result as { dataUrl: string }).dataUrl).toMatch(/^data:image\/png;base64,/)
  })

  it('a .docx file goes through runOfficeHtml and renders as html', async () => {
    filePathFor.mockReturnValue('/ws/report.docx')
    statSync.mockReturnValue({ size: 10 })
    readFileSync.mockReturnValue(Buffer.from('docxbytes'))
    runOfficeHtml.mockResolvedValue('<p>doc text</p>')

    const result = await handlers.get('bearcode:diffs:preview')!({}, 'f3')

    expect(runOfficeHtml).toHaveBeenCalledWith(Buffer.from('docxbytes'))
    expect(result).toEqual({ kind: 'html', html: '<p>doc text</p>' })
  })

  it('a .docx file that fails to render is unsupported', async () => {
    filePathFor.mockReturnValue('/ws/report.docx')
    statSync.mockReturnValue({ size: 10 })
    readFileSync.mockReturnValue(Buffer.from('docxbytes'))
    runOfficeHtml.mockResolvedValue(null)

    const result = await handlers.get('bearcode:diffs:preview')!({}, 'f3')

    expect(result).toEqual({ kind: 'unsupported', note: 'Could not render document' })
  })

  it('an .xlsx file goes through runOfficeRows and renders as a table', async () => {
    filePathFor.mockReturnValue('/ws/data.xlsx')
    statSync.mockReturnValue({ size: 10 })
    readFileSync.mockReturnValue(Buffer.from('xlsxbytes'))
    runOfficeRows.mockResolvedValue([['A', 'B'], ['1', '2']])

    const result = await handlers.get('bearcode:diffs:preview')!({}, 'f4')

    expect(runOfficeRows).toHaveBeenCalledWith(Buffer.from('xlsxbytes'))
    expect(result).toEqual({ kind: 'table', rows: [['A', 'B'], ['1', '2']] })
  })

  it('a .md file renders as markdown text', async () => {
    filePathFor.mockReturnValue('/ws/notes.md')
    statSync.mockReturnValue({ size: 10 })
    readFileSync.mockReturnValue(Buffer.from('# Hi'))

    const result = await handlers.get('bearcode:diffs:preview')!({}, 'f5')

    expect(result).toEqual({ kind: 'markdown', text: '# Hi' })
  })

  it('a .csv file renders as a table', async () => {
    filePathFor.mockReturnValue('/ws/data.csv')
    statSync.mockReturnValue({ size: 10 })
    readFileSync.mockReturnValue(Buffer.from('a,b\n1,2'))

    const result = await handlers.get('bearcode:diffs:preview')!({}, 'f6')

    expect(result).toEqual({ kind: 'table', rows: [['a', 'b'], ['1', '2']] })
  })

  it('a .svg file becomes an image data URL', async () => {
    filePathFor.mockReturnValue('/ws/icon.svg')
    statSync.mockReturnValue({ size: 10 })
    readFileSync.mockReturnValue(Buffer.from('<svg></svg>'))

    const result = await handlers.get('bearcode:diffs:preview')!({}, 'f7')

    expect(result).toMatchObject({ kind: 'image' })
    expect((result as { dataUrl: string }).dataUrl).toMatch(/^data:image\/svg\+xml;base64,/)
  })

  it('a .pdf file becomes a pdf data URL', async () => {
    filePathFor.mockReturnValue('/ws/doc.pdf')
    statSync.mockReturnValue({ size: 10 })
    readFileSync.mockReturnValue(Buffer.from('pdfbytes'))

    const result = await handlers.get('bearcode:diffs:preview')!({}, 'f8')

    expect(result).toMatchObject({ kind: 'pdf' })
    expect((result as { dataUrl: string }).dataUrl).toMatch(/^data:application\/pdf;base64,/)
  })

  it('a .ts file renders as code with the typescript language', async () => {
    filePathFor.mockReturnValue('/ws/app.ts')
    statSync.mockReturnValue({ size: 10 })
    readFileSync.mockReturnValue(Buffer.from('const x = 1'))

    const result = await handlers.get('bearcode:diffs:preview')!({}, 'f9')

    expect(result).toEqual({ kind: 'code', text: 'const x = 1', language: 'typescript' })
  })

  it('a .json file is pretty-printed as code', async () => {
    filePathFor.mockReturnValue('/ws/data.json')
    statSync.mockReturnValue({ size: 10 })
    readFileSync.mockReturnValue(Buffer.from('{"a":1}'))

    const result = await handlers.get('bearcode:diffs:preview')!({}, 'f10')

    expect(result).toEqual({ kind: 'code', text: '{\n  "a": 1\n}', language: 'json' })
  })

  it('an .html file renders as html', async () => {
    filePathFor.mockReturnValue('/ws/page.html')
    statSync.mockReturnValue({ size: 10 })
    readFileSync.mockReturnValue(Buffer.from('<h1>hi</h1>'))

    const result = await handlers.get('bearcode:diffs:preview')!({}, 'f11')

    // Asset inlining leaves this markup untouched (no <link>/<script src>), and
    // the anchor-scroll guard is appended for the blob-URL preview iframe.
    expect(result.kind).toBe('html')
    expect((result as { html: string }).html).toContain('<h1>hi</h1>')
    expect((result as { html: string }).html).toContain('scrollIntoView')
  })

  it('an unknown fileId (filePathFor -> null) is unsupported', async () => {
    filePathFor.mockReturnValue(null)

    const result = await handlers.get('bearcode:diffs:preview')!({}, 'nope')

    expect(result).toEqual({ kind: 'unsupported', note: 'File not found' })
    expect(statSync).not.toHaveBeenCalled()
  })

  it('an oversize file is unsupported without reading bytes', async () => {
    filePathFor.mockReturnValue('/ws/huge.txt')
    statSync.mockReturnValue({ size: 11 * 1024 * 1024 })

    const result = await handlers.get('bearcode:diffs:preview')!({}, 'huge')

    expect(result).toEqual({ kind: 'unsupported', note: 'File too large to preview' })
    expect(readFileSync).not.toHaveBeenCalled()
  })
})
