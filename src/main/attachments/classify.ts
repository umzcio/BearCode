// Lane classification for the + picker (D5). Binary lanes are sniffed from
// magic bytes (never the extension) exactly as D4 did for images; the inert
// TEXT lane is the ONE relaxation — routed by extension allowlist + a
// UTF-8-clean gate — safe because text is inlined as prompt text the model
// reads, never decoded as pixels, run, or written back as code. The extension
// never authorises a filesystem path (that stays the id grammar).
import { extname } from 'path'
import {
  DOCX_MIME,
  PDF_MIME,
  TEXT_EXTENSIONS,
  XLSX_MIME,
  type AttachmentKind
} from '../../shared/types'
import { sniffImageMime } from './ingest'

// Decodes cleanly as UTF-8 AND has no NUL byte in the leading window. NUL is
// the cheapest binary tell; the strict decode rejects invalid multi-byte runs.
export function isUtf8Clean(buf: Buffer): boolean {
  if (buf.includes(0x00)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

// PURE. Returns the lane + a storage mime, or null for unsupported/spoofed
// input. `bytes` is the whole picked file; `name` supplies only the text-lane
// routing hint (gated behind isUtf8Clean) and is never trusted otherwise.
export function classifyPicked(
  bytes: Buffer,
  name: string
): { kind: AttachmentKind; mime: string } | null {
  const image = sniffImageMime(bytes)
  if (image) return { kind: 'image', mime: image }

  // pdf: "%PDF-" at offset 0.
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return { kind: 'pdf', mime: PDF_MIME }
  }

  // office: OOXML is a ZIP ("PK\x03\x04"). Disambiguate docx vs xlsx by peeking
  // the OOXML container paths, which appear verbatim in ZIP local file headers.
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    const head = bytes.subarray(0, Math.min(bytes.length, 4096)).toString('latin1')
    if (head.includes('word/document.xml')) return { kind: 'office', mime: DOCX_MIME }
    if (head.includes('xl/workbook.xml')) return { kind: 'office', mime: XLSX_MIME }
    // A larger scan for containers whose central directory sits past 4 KB.
    const full = bytes.toString('latin1')
    if (full.includes('word/document.xml')) return { kind: 'office', mime: DOCX_MIME }
    if (full.includes('xl/workbook.xml')) return { kind: 'office', mime: XLSX_MIME }
    return null
  }

  // text lane: extension allowlist + UTF-8-clean gate on the leading window.
  const ext = extname(name).slice(1).toLowerCase()
  if ((TEXT_EXTENSIONS as readonly string[]).includes(ext)) {
    const window = bytes.subarray(0, Math.min(bytes.length, 64 * 1024))
    if (isUtf8Clean(window)) return { kind: 'text', mime: 'text/plain' }
  }
  return null
}
