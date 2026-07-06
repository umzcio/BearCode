// Office (docx/xlsx) extraction (D5). docx -> mammoth.extractRawText (NOT
// convertToHtml, so mammoth's "no sanitization" note never applies); xlsx ->
// per-sheet CSV via exceljs. exceljs is used (not npm `xlsx`, which is frozen
// at the CVE-vulnerable 0.18.5). extractOfficeCore is the pure-ish unit;
// runOfficeExtraction wraps it in a killable worker with a wall-clock timeout
// so a zip-bomb cannot wedge the main process.
import { join } from 'path'
import { Worker } from 'worker_threads'
import mammoth from 'mammoth'
import ExcelJS from 'exceljs'
import { DOCX_MIME, XLSX_MIME } from '../../shared/types'
import { capText, TRUNCATE_NOTICE, type ExtractResult } from './extract'

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
// timeout in runOfficeExtraction can fire between steps; the worker guards the
// synchronous-decompression case.
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

function badgeFor(mime: string): string {
  return mime === DOCX_MIME ? 'DOCX' : 'XLSX'
}

// Spawn the worker, race it against a wall-clock timeout, and terminate() on
// timeout (worker_threads.terminate truly kills CPU-bound work — a Promise.race
// alone would not, since a synchronous decompress bomb wedges the thread it
// runs on). Fails soft to { text:'', notice }.
export async function runOfficeExtraction(
  mime: string,
  bytes: Buffer,
  timeoutMs = 10_000
): Promise<ExtractResult> {
  const workerPath = join(__dirname, 'officeWorker.js')
  const badge = badgeFor(mime)
  const raw = await new Promise<string | null>((resolve) => {
    const worker = new Worker(workerPath, { workerData: { mime, bytes } })
    const timer = setTimeout(() => {
      void worker.terminate()
      resolve(null)
    }, timeoutMs)
    worker.once('message', (msg: { ok: boolean; text?: string }) => {
      clearTimeout(timer)
      void worker.terminate()
      resolve(msg.ok ? (msg.text ?? '') : null)
    })
    worker.once('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
  })
  if (raw === null) {
    return { text: '', truncated: false, notice: `${badge} · could not extract`, badge }
  }
  const { text, truncated } = capText(raw)
  const empty = text.trim() === ''
  return {
    text: empty ? '' : text,
    truncated,
    notice: empty ? `${badge} · no extractable text` : truncated ? TRUNCATE_NOTICE : null,
    badge
  }
}
