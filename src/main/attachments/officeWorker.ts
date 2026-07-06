// Killable child for attachment extraction (D5 zip-bomb defence; D4-hardening
// extends it to PDF). Bundled as a separate main-process entry
// (electron.vite.config). Receives an ExtractionJob via workerData, posts
// { ok, text, totalPages? } | { ok:false }. The parent (office.ts)
// terminate()s it on a wall-clock timeout.
//
// The parser libs (mammoth/exceljs via officeCore.ts, unpdf via extract.ts)
// are only ever imported from THIS worker file -- never from office.ts, which
// ingest.ts pulls in at main-process startup -- so none of them load on the
// main thread.
import { parentPort, workerData } from 'worker_threads'
import { extractOfficeCore } from './officeCore'
import { extractPdfCore } from './extract'

type Job = { kind: 'office'; mime: string; bytes: Buffer } | { kind: 'pdf'; bytes: Buffer }

async function main(): Promise<void> {
  const job = workerData as Job
  try {
    if (job.kind === 'pdf') {
      const { text, totalPages } = await extractPdfCore(Buffer.from(job.bytes))
      parentPort?.postMessage({ ok: true, text, totalPages })
    } else {
      const text = await extractOfficeCore(job.mime, Buffer.from(job.bytes))
      parentPort?.postMessage({ ok: true, text })
    }
  } catch {
    parentPort?.postMessage({ ok: false })
  }
}

void main()
