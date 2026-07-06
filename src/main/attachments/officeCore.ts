// Office (docx/xlsx) parsing core (D5; D4-hardening moved this out of
// office.ts). docx -> mammoth.extractRawText (NOT convertToHtml, so mammoth's
// "no sanitization" note never applies); xlsx -> per-sheet CSV via exceljs.
// exceljs is used (not npm `xlsx`, which is frozen at the CVE-vulnerable
// 0.18.5).
//
// SECURITY/PERF: mammoth and exceljs are imported at MODULE TOP LEVEL here on
// purpose, and this file must only ever be imported by officeWorker.ts (the
// killable worker_threads entry). office.ts -- which ingest.ts pulls in at
// main-process startup -- imports neither this file nor these libraries, so
// the parser libs load ONLY inside the worker, never in the main bundle.
import mammoth from 'mammoth'
import ExcelJS from 'exceljs'
import { DOCX_MIME, XLSX_MIME } from '../../shared/types'

// PURE CSV row builder with RFC-4180 escaping.
export function xlsxRowsToCsv(rows: unknown[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const s = cell === undefined || cell === null ? '' : String(cell)
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
        })
        .join(',')
    )
    .join('\n')
}

// Parse the bytes and return plain text. Async (both parsers yield), so a
// timeout in office.ts's runOfficeExtraction can fire between steps; the
// worker guards the synchronous-decompression case.
export async function extractOfficeCore(mime: string, bytes: Buffer): Promise<string> {
  if (mime === DOCX_MIME) {
    const { value } = await mammoth.extractRawText({ buffer: bytes })
    return value
  }
  if (mime === XLSX_MIME) {
    const wb = new ExcelJS.Workbook()
    // exceljs's bundled d.ts redeclares a global `Buffer extends ArrayBuffer`
    // that is missing newer Node Buffer members vs. @types/node, so the
    // structural check on `load`'s parameter type fails even though a real
    // Node Buffer is exactly what it expects at runtime.
    await wb.xlsx.load(bytes as unknown as Parameters<typeof wb.xlsx.load>[0])
    const parts: string[] = []
    for (const sheet of wb.worksheets) {
      const rows: unknown[][] = []
      sheet.eachRow((row) => {
        // exceljs row.values is 1-indexed (index 0 is undefined); drop it.
        const values = (row.values as unknown[]).slice(1)
        rows.push(values)
      })
      parts.push(`## Sheet: ${sheet.name}\n${xlsxRowsToCsv(rows)}`)
    }
    return parts.join('\n\n')
  }
  throw new Error(`unsupported office mime: ${mime}`)
}
