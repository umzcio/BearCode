// Text + PDF extraction for the + picker (D5). Runs MAIN-side on user-picked
// bytes and NEVER executes them: bytes -> pure-JS parser -> text. PDF uses
// unpdf (a serverless PDF.js build; no canvas/DOM) with isEvalSupported:false
// so a malicious PDF cannot run JS (CVE-2024-4367 class — unpdf bundles
// pdfjs-dist ~5.6.205, well past the 4.2.67 fix; isEvalSupported:false is
// belt-and-suspenders on top of that and unpdf's own default). Every path
// fails soft to { text:'', notice } so one bad attachment never breaks the
// turn.
import { extractText as unpdfExtractText, getDocumentProxy } from 'unpdf'

export interface ExtractResult {
  text: string
  truncated: boolean
  notice: string | null
  // Short pill badge, e.g. "TXT · 4 KB" / "PDF · 12 pp".
  badge: string
}

// Per-file extracted-text cap (256 KB ≈ 64K tokens). A deliberate attach is a
// bigger budget than the .agents 64 KB cross-ref cap. The aggregate budget
// (Task 6) bounds the sum across all attachments.
export const MAX_INLINE_TEXT_BYTES_PER_FILE = 256 * 1024
export const TRUNCATE_NOTICE = '… (truncated at 256 KB)'

function humanBytes(n: number): string {
  return n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`
}

// PURE. Caps a string by UTF-8 byte length (slicing on the byte buffer, which
// may drop a trailing partial code point — acceptable for an inlined preview).
export function capText(
  s: string,
  maxBytes: number = MAX_INLINE_TEXT_BYTES_PER_FILE
): { text: string; truncated: boolean } {
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= maxBytes) return { text: s, truncated: false }
  return { text: buf.subarray(0, maxBytes).toString('utf8'), truncated: true }
}

// UTF-8 text/code lane: decode + cap. Bytes are already UTF-8-clean-gated by the
// classifier, so a lenient decode here is fine.
export function extractTextLane(bytes: Buffer): ExtractResult {
  const decoded = bytes.toString('utf8')
  const { text, truncated } = capText(decoded)
  return {
    text,
    truncated,
    notice: truncated ? TRUNCATE_NOTICE : null,
    badge: `TXT · ${humanBytes(bytes.length)}`
  }
}

// PDF lane, core parse only (no cap/badge/notice): extract text with unpdf.
// Throws on a bad/unparseable PDF -- callers decide how to fail soft. Split
// out (D4-hardening) so this can run either directly (extractPdf, below) or
// inside the killable worker (officeWorker.ts / office.ts's
// runPdfExtraction), which gives a pathological PDF the same wall-clock
// terminate() guard Office extraction already had instead of running
// unguarded on the main-process event loop.
export async function extractPdfCore(bytes: Buffer): Promise<{ text: string; totalPages: number }> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { isEvalSupported: false })
  const { totalPages, text } = await unpdfExtractText(pdf, { mergePages: true })
  const merged = Array.isArray(text) ? text.join('\n\n') : text
  return { text: merged, totalPages }
}

// PURE post-processing shared by extractPdf (direct call, below) and
// office.ts's runPdfExtraction (worker-routed call): caps text and picks the
// badge/notice, surfacing the "no extractable text" case (scanned/image-only
// PDFs) so the user knows why the model saw nothing. `raw` is null when the
// core threw, or (worker path) the wall-clock timeout fired / the worker
// errored.
export function pdfResultFromRaw(raw: { text: string; totalPages: number } | null): ExtractResult {
  if (raw === null) {
    return { text: '', truncated: false, notice: 'PDF · could not extract text', badge: 'PDF' }
  }
  const { text: capped, truncated } = capText(raw.text)
  const empty = capped.trim() === ''
  return {
    text: empty ? '' : capped,
    truncated,
    notice: empty
      ? 'PDF · no extractable text (scanned or image-only)'
      : truncated
        ? TRUNCATE_NOTICE
        : null,
    badge: `PDF · ${raw.totalPages} pp`
  }
}

// Direct (non-worker) PDF extraction. D4-hardening note: production ingest
// now routes PDFs through office.ts's runPdfExtraction (the SAME killable
// worker Office extraction uses), so a pathological PDF cannot wedge the main
// thread; this direct path remains for unit coverage of the cap/notice logic
// in isolation and for any caller that doesn't need the wall-clock guard.
export async function extractPdf(bytes: Buffer): Promise<ExtractResult> {
  try {
    return pdfResultFromRaw(await extractPdfCore(bytes))
  } catch {
    return pdfResultFromRaw(null)
  }
}
