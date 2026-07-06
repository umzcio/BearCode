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
const { filePathFor, statSync, readFileSync, runPdfExtraction, runOfficeExtraction, extractTextLane } =
  vi.hoisted(() => ({
    filePathFor: vi.fn(),
    statSync: vi.fn(),
    readFileSync: vi.fn(),
    runPdfExtraction: vi.fn(),
    runOfficeExtraction: vi.fn(),
    extractTextLane: vi.fn()
  }))
vi.mock('./diffs', () => ({ filePathFor, getDiff: vi.fn(), revertFile: vi.fn() }))
vi.mock('fs', () => ({ statSync, readFileSync }))
vi.mock('./attachments/office', () => ({ runPdfExtraction, runOfficeExtraction }))
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

  it('a .docx file goes through runOfficeExtraction with the docx mime', async () => {
    filePathFor.mockReturnValue('/ws/report.docx')
    statSync.mockReturnValue({ size: 10 })
    readFileSync.mockReturnValue(Buffer.from('docxbytes'))
    runOfficeExtraction.mockResolvedValue({ text: 'doc text', truncated: false })

    const result = await handlers.get('bearcode:diffs:preview')!({}, 'f3')

    expect(runOfficeExtraction).toHaveBeenCalledWith(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      Buffer.from('docxbytes')
    )
    expect(result).toEqual({ kind: 'text', text: 'doc text', truncated: false })
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
