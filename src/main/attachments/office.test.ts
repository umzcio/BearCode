import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// office.ts's runInWorker spawns a real worker_threads.Worker pointed at
// officeWorker.js. Stub the module with a controllable fake so these tests
// exercise the SPAWN/RACE/TERMINATE contract (message / error / wall-clock
// timeout) without an actual worker thread or a built officeWorker.js.
// Wrapped in vi.hoisted so the class exists by the time the (hoisted)
// vi.mock factory below runs (vitest only hoists vi.fn()-style bindings
// automatically, not plain class declarations) -- mirrors officeCore.test.ts.
const { FakeWorker, workers } = vi.hoisted(() => {
  const workers: InstanceType<typeof FakeWorkerImpl>[] = []
  class FakeWorkerImpl {
    path: string
    opts: unknown
    handlers: Record<string, (arg?: unknown) => void> = {}
    terminate = vi.fn()
    constructor(path: string, opts: unknown) {
      this.path = path
      this.opts = opts
      workers.push(this)
    }
    once(event: string, cb: (arg?: unknown) => void): void {
      this.handlers[event] = cb
    }
    emit(event: string, arg?: unknown): void {
      this.handlers[event]?.(arg)
    }
  }
  return { FakeWorker: FakeWorkerImpl, workers }
})
vi.mock('worker_threads', () => ({ Worker: FakeWorker }))

import { runOfficeExtraction, runPdfExtraction } from './office'
import { DOCX_MIME } from '../../shared/types'

beforeEach(() => {
  workers.length = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('runOfficeExtraction', () => {
  it('resolves with the parsed text and DOCX badge on a successful worker message', async () => {
    const p = runOfficeExtraction(DOCX_MIME, Buffer.from('zip'))
    workers[0].emit('message', { ok: true, text: 'Hello body' })
    const out = await p
    expect(out.text).toBe('Hello body')
    expect(out.badge).toBe('DOCX')
    expect(out.notice).toBeNull()
    expect(workers[0].terminate).toHaveBeenCalledTimes(1)
  })

  it('fails soft with a "could not extract" notice on a wall-clock timeout, and terminates the worker', async () => {
    vi.useFakeTimers()
    const p = runOfficeExtraction(DOCX_MIME, Buffer.from('zip'), 50)
    vi.advanceTimersByTime(50)
    const out = await p
    expect(out.text).toBe('')
    expect(out.notice).toMatch(/could not extract/i)
    expect(workers[0].terminate).toHaveBeenCalledTimes(1)
  })

  it('clears the wall-clock timer on a worker "error" event (no dangling timeout left running)', async () => {
    vi.useFakeTimers()
    const clearSpy = vi.spyOn(global, 'clearTimeout')
    const p = runOfficeExtraction(DOCX_MIME, Buffer.from('zip'), 50)
    workers[0].emit('error', new Error('boom'))
    const out = await p
    expect(out.notice).toMatch(/could not extract/i)
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })
})

describe('runPdfExtraction (D4-hardening: PDF now goes through the same killable worker as Office)', () => {
  it('resolves the extracted text and a page-count badge on success', async () => {
    const p = runPdfExtraction(Buffer.from('%PDF-1.7'))
    workers[0].emit('message', { ok: true, text: 'page text', totalPages: 3 })
    const out = await p
    expect(out.text).toBe('page text')
    expect(out.badge).toBe('PDF · 3 pp')
    expect(out.notice).toBeNull()
  })

  it('a pathological PDF that never responds is abandoned at the wall-clock timeout, returns a soft-fail result, and terminates the worker (main thread is never left blocked indefinitely)', async () => {
    vi.useFakeTimers()
    const p = runPdfExtraction(Buffer.from('%PDF-1.7'), 50)
    vi.advanceTimersByTime(50)
    const out = await p
    expect(out.text).toBe('')
    expect(out.notice).toMatch(/could not extract/i)
    expect(workers[0].terminate).toHaveBeenCalledTimes(1)
  })

  it('fails soft when the worker reports ok:false (core threw inside the worker)', async () => {
    const p = runPdfExtraction(Buffer.from('not a pdf'))
    workers[0].emit('message', { ok: false })
    const out = await p
    expect(out.text).toBe('')
    expect(out.notice).toMatch(/could not extract/i)
  })
})
