import { describe, it, expect } from 'vitest'
import mammoth from 'mammoth'
import ExcelJS from 'exceljs'
import { generateDocument } from './generate'
import { extractPdfCore } from '../attachments/extract'

describe('generateDocument', () => {
  it('docx contains the content (mammoth round-trip)', async () => {
    const buf = await generateDocument('docx', '# Title\n\nHello from BearCode.')
    expect(buf.length).toBeGreaterThan(0)
    expect(buf.subarray(0, 2).toString()).toBe('PK') // zip/OOXML magic
    const { value } = await mammoth.extractRawText({ buffer: buf })
    expect(value).toContain('Title')
    expect(value).toContain('Hello from BearCode')
  })
  it('xlsx contains the rows (exceljs round-trip)', async () => {
    const buf = await generateDocument('xlsx', 'Name\tScore\nAda\t99')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf)
    const ws = wb.worksheets[0]
    expect(ws.getCell('A1').value).toBe('Name')
    expect(ws.getCell('B2').value).toBe('99')
  })
  it('pdf is a valid PDF containing the content (unpdf round-trip)', async () => {
    const buf = await generateDocument('pdf', 'Report line one.\nReport line two.')
    expect(buf.subarray(0, 4).toString()).toBe('%PDF')
    const { text, totalPages } = await extractPdfCore(buf)
    expect(totalPages).toBeGreaterThanOrEqual(1)
    expect(text).toContain('Report line one')
  })
  it('rejects an unknown format', async () => {
    // @ts-expect-error deliberate bad format
    await expect(generateDocument('rtf', 'x')).rejects.toThrow(/format/i)
  })
})
