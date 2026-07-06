import { describe, it, expect, vi, beforeEach } from 'vitest'

const extractRawTextMock = vi.fn()
vi.mock('mammoth', () => ({
  default: { extractRawText: (...a: unknown[]) => extractRawTextMock(...a) },
  extractRawText: (...a: unknown[]) => extractRawTextMock(...a)
}))

// exceljs: a fake Workbook whose xlsx.load fills two sheets. Wrapped in
// vi.hoisted so the classes exist by the time the (hoisted) vi.mock factory
// below runs (vitest only hoists vi.fn()-style bindings automatically, not
// plain class declarations).
const { FakeWorkbook } = vi.hoisted(() => {
  class FakeWorksheet {
    name: string
    private rows: unknown[][]
    constructor(name: string, rows: unknown[][]) {
      this.name = name
      this.rows = rows
    }
    eachRow(cb: (row: { values: unknown[] }, n: number) => void): void {
      this.rows.forEach((r, i) => cb({ values: [undefined, ...r] }, i + 1))
    }
  }
  class FakeWorkbook {
    worksheets: InstanceType<typeof FakeWorksheet>[] = []
    xlsx = {
      load: async (): Promise<void> => {
        this.worksheets = [
          new FakeWorksheet('Sheet1', [
            ['a', 'b'],
            [1, 2]
          ]),
          new FakeWorksheet('Totals', [['x'], [42]])
        ]
      }
    }
  }
  return { FakeWorkbook }
})
vi.mock('exceljs', () => ({ default: { Workbook: FakeWorkbook }, Workbook: FakeWorkbook }))

import { xlsxRowsToCsv, extractOfficeCore } from './office'
import { DOCX_MIME, XLSX_MIME } from '../../shared/types'

beforeEach(() => extractRawTextMock.mockReset())

describe('xlsxRowsToCsv', () => {
  it('joins cells with commas and rows with newlines', () => {
    expect(xlsxRowsToCsv([['a', 'b'], [1, 2]])).toBe('a,b\n1,2')
  })
  it('quotes cells containing comma/quote/newline', () => {
    expect(xlsxRowsToCsv([['a,b', 'c"d', 'e\nf']])).toBe('"a,b","c""d","e\nf"')
  })
  it('renders empty cells as empty strings', () => {
    expect(xlsxRowsToCsv([['a', undefined, null]])).toBe('a,,')
  })
})

describe('extractOfficeCore', () => {
  it('docx -> raw text via mammoth', async () => {
    extractRawTextMock.mockResolvedValue({ value: 'Title\nBody' })
    expect(await extractOfficeCore(DOCX_MIME, Buffer.from('zip'))).toBe('Title\nBody')
  })

  it('xlsx -> one titled CSV block per sheet', async () => {
    const out = await extractOfficeCore(XLSX_MIME, Buffer.from('zip'))
    expect(out).toContain('## Sheet: Sheet1')
    expect(out).toContain('a,b\n1,2')
    expect(out).toContain('## Sheet: Totals')
    expect(out).toContain('x\n42')
  })
})
