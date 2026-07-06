// Killable-worker extraction runner (D5 zip-bomb defence). D4-hardening
// extends the SAME worker to PDF (see officeWorker.ts / extract.ts) so unpdf
// gets the same wall-clock terminate() guard Office extraction already had --
// PDF parsing was previously running unguarded on the main-process event
// loop. extractOfficeCore/xlsxRowsToCsv (mammoth/exceljs) live in
// officeCore.ts, imported ONLY by officeWorker.ts: this file just spawns,
// races, and terminates the worker, so the parser libs never load on the main
// thread at startup.
import { join } from 'path'
import { Worker } from 'worker_threads'
import { DOCX_MIME, XLSX_MIME } from '../../shared/types'
import { capText, TRUNCATE_NOTICE, pdfResultFromRaw, type ExtractResult } from './extract'

type ExtractionJob =
  { kind: 'office'; mime: string; bytes: Buffer } | { kind: 'pdf'; bytes: Buffer }

// Raw success payload from the worker, before cap/badge/notice post-processing.
interface WorkerRaw {
  text: string
  totalPages?: number
}

function badgeFor(mime: string): string {
  if (mime === DOCX_MIME) return 'DOCX'
  if (mime === XLSX_MIME) return 'XLSX'
  return 'PDF'
}

// Spawn the worker, race it against a wall-clock timeout, and terminate() on
// timeout (worker_threads.terminate truly kills CPU-bound work -- a
// Promise.race alone would not, since a synchronous decompress bomb or a
// pathological PDF wedges the thread it runs on, not just a microtask queue).
// Resolves null on timeout, a worker 'error' event, or an { ok:false }
// message. clearTimeout runs on EVERY settling path (message, error, and the
// timeout branch itself) so no dangling wall-clock timer survives the call.
function runInWorker(job: ExtractionJob, timeoutMs: number): Promise<WorkerRaw | null> {
  const workerPath = join(__dirname, 'officeWorker.js')
  return new Promise((resolve) => {
    const worker = new Worker(workerPath, { workerData: job })
    const timer = setTimeout(() => {
      void worker.terminate()
      resolve(null)
    }, timeoutMs)
    worker.once('message', (msg: { ok: boolean; text?: string; totalPages?: number }) => {
      clearTimeout(timer)
      void worker.terminate()
      resolve(msg.ok ? { text: msg.text ?? '', totalPages: msg.totalPages } : null)
    })
    worker.once('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
  })
}

// Office (docx/xlsx) lane. Fails soft to { text:'', notice }.
export async function runOfficeExtraction(
  mime: string,
  bytes: Buffer,
  timeoutMs = 10_000
): Promise<ExtractResult> {
  const badge = badgeFor(mime)
  const raw = await runInWorker({ kind: 'office', mime, bytes }, timeoutMs)
  if (raw === null) {
    return { text: '', truncated: false, notice: `${badge} · could not extract`, badge }
  }
  const { text, truncated } = capText(raw.text)
  const empty = text.trim() === ''
  return {
    text: empty ? '' : text,
    truncated,
    notice: empty ? `${badge} · no extractable text` : truncated ? TRUNCATE_NOTICE : null,
    badge
  }
}

// PDF lane (D4-hardening). Runs unpdf in the SAME killable worker as Office so
// a crafted PDF that wedges pdf.js's synchronous parsing cannot freeze the
// main-process event loop indefinitely -- a plain setTimeout/Promise.race in
// the main process would not preempt that (see runInWorker doc above). Fails
// soft to { text:'', notice: 'PDF · could not extract text' }.
export async function runPdfExtraction(bytes: Buffer, timeoutMs = 10_000): Promise<ExtractResult> {
  const raw = await runInWorker({ kind: 'pdf', bytes }, timeoutMs)
  return pdfResultFromRaw(raw === null ? null : { text: raw.text, totalPages: raw.totalPages ?? 0 })
}
