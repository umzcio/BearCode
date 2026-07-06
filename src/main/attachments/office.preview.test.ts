import { describe, it, expect, vi } from 'vitest'

// office.ts's runInWorker spawns a real worker_threads.Worker pointed at the
// BUILT officeWorker.js -- unavailable when running .ts sources directly
// under vitest (same boundary office.test.ts already fakes for the
// office/pdf job kinds). This FakeWorker plays officeWorker.ts's main() role
// for real: it calls the REAL officeCore functions (real mammoth/exceljs)
// against the workerData bytes and posts a real result, so the docx/xlsx
// round-trip through runOfficeHtml/runOfficeRows is exercised end-to-end --
// only the process-boundary spawn is stubbed, never the extraction logic.
const { FakeWorker } = vi.hoisted(() => {
  class FakeWorkerImpl {
    private handlers: Record<string, (arg?: unknown) => void> = {}
    terminate = vi.fn()
    constructor(_path: string, opts: { workerData: { kind: string; bytes: Buffer } }) {
      const job = opts.workerData
      void (async () => {
        // Mirrors officeWorker.ts's main(): import lazily so this file's
        // static imports don't pull mammoth/exceljs before vi.mock below runs.
        const { extractOfficeHtml, extractXlsxRows } = await import('./officeCore')
        try {
          if (job.kind === 'office-html') {
            const html = await extractOfficeHtml(Buffer.from(job.bytes))
            this.handlers.message?.({ ok: true, html })
          } else if (job.kind === 'office-rows') {
            const rows = await extractXlsxRows(Buffer.from(job.bytes))
            this.handlers.message?.({ ok: true, rows })
          } else {
            this.handlers.message?.({ ok: false })
          }
        } catch {
          this.handlers.message?.({ ok: false })
        }
      })()
    }
    once(event: string, cb: (arg?: unknown) => void): void {
      this.handlers[event] = cb
    }
  }
  return { FakeWorker: FakeWorkerImpl }
})
vi.mock('worker_threads', () => ({ Worker: FakeWorker }))

import { generateDocument } from '../docgen/generate'
import { runOfficeHtml, runOfficeRows } from './office'

describe('runOfficeHtml (docx -> mammoth.convertToHtml, via the office-html job)', () => {
  it('returns HTML containing the heading and body text of a real generated docx', async () => {
    const buf = await generateDocument('docx', '# Title\nHello')
    const html = await runOfficeHtml(buf)
    expect(html).not.toBeNull()
    expect(html).toContain('Title')
    expect(html).toContain('Hello')
    expect(html).toContain('<')
  })
})

describe('runOfficeRows (xlsx -> first-sheet rows, via the office-rows job)', () => {
  it('returns the sheet rows as string arrays from a real generated xlsx', async () => {
    const buf = await generateDocument('xlsx', 'A\tB\n1\t2')
    const rows = await runOfficeRows(buf)
    expect(rows).not.toBeNull()
    expect(rows).toEqual([
      ['A', 'B'],
      ['1', '2']
    ])
  })
})
