// Main-side image-attachment ingest (D4 design 8/10). Bytes are copied to
// userData/attachments/<convId>/<id> at pick time and NEVER executed; the mime
// is sniffed from the leading bytes (magic numbers), NOT the file extension
// (design 10). png/jpg/webp/gif only; PDFs are out of scope for D4. Caps:
// 10 MB per file, 5 attachments per message.
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { app } from 'electron'
import { ATTACHMENT_MIME_TYPES, type AttachmentRef } from '../../shared/types'
import { classifyPicked } from './classify'
import { extractTextLane, type ExtractResult } from './extract'
import { runOfficeExtraction, runPdfExtraction } from './office'

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024 // 10 MB
export const MAX_ATTACHMENTS_PER_MESSAGE = 5

// SECURITY: conversationId is used to build the on-disk path
// userData/attachments/<convId>/<id>. Unlike `id` (minted main-side via
// randomUUID, or wire-validated by assertValidAttachments before it ever
// reaches here), conversationId is a renderer-supplied string threaded
// straight through from the UI. It MUST be validated against this strict
// grammar at the top of every function that turns it into a filesystem path,
// BEFORE any mkdir/write/read -- otherwise it is an equally unguarded
// traversal primitive ('..', '/', '\' segments) as an unchecked id would be.
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
// Exported for reuse where a renderer-supplied conversation id crosses another
// IPC boundary before ever touching the filesystem (e.g. conversations:create,
// which accepts an optional client-minted draft id -- src/main/ipc.ts).
export function assertValidConversationId(conversationId: string): void {
  if (typeof conversationId !== 'string' || !CONVERSATION_ID_PATTERN.test(conversationId)) {
    throw new Error('attachments: conversationId must match /^[A-Za-z0-9_-]{1,64}$/')
  }
}

// Same grammar assertValidAttachments enforces at the run:start wire boundary
// (src/main/orchestrator/index.ts). Re-checked here for the transcript read
// IPC because that id, unlike readAttachmentBase64's (which only ever carries
// already-wire-validated AttachmentRef.id values from a live turn), is read
// straight off a persisted event on every transcript render/reload.
const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
function assertValidAttachmentId(id: string): void {
  if (typeof id !== 'string' || !ATTACHMENT_ID_PATTERN.test(id)) {
    throw new Error('attachments: id must match /^[A-Za-z0-9_-]{1,64}$/')
  }
}

export interface PickedAttachment {
  ref: AttachmentRef
  // A data: URL of the copied image, for the composer thumbnail pill only.
  // Not persisted and not sent to the model (the model gets fresh base64 from
  // the copied file at turn time). Empty string for non-image lanes.
  previewDataUrl: string
  // Non-image lanes: a short pick-time notice for the pill (truncation / "no
  // extractable text"). Not persisted, not sent to the model.
  notice?: string | null
}

// Magic-byte sniff. PURE. Returns a supported mime or null. Signatures:
//   PNG  89 50 4E 47
//   JPEG FF D8 FF
//   GIF  "GIF8"
//   WEBP "RIFF"...."WEBP" (bytes 0-3 RIFF, 8-11 WEBP)
export function sniffImageMime(bytes: Buffer): (typeof ATTACHMENT_MIME_TYPES)[number] | null {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif'
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

// The deterministic on-disk path for an attachment. PURE. `id` is path-safe by
// construction (randomUUID here; assertValidAttachments enforces the pattern at
// the wire), `convId` is validated by callers below before this is invoked.
export function attachmentPath(userDataDir: string, convId: string, id: string): string {
  return join(userDataDir, 'attachments', convId, id)
}

// PURE limit check. Returns an error string (for the user) or null if the file
// is acceptable to add. `existingCount` is how many are already on the message.
export function checkPickLimits(existingCount: number, sizeBytes: number): string | null {
  if (existingCount >= MAX_ATTACHMENTS_PER_MESSAGE) {
    return `You can attach at most ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.`
  }
  if (sizeBytes > MAX_ATTACHMENT_BYTES) {
    return `File is larger than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB.`
  }
  return null
}

// Read, classify, cap-check, and copy each picked file (D5). Non-image lanes
// are extracted once here and cached as a <id>.txt sidecar so turn time is a
// cheap read and the composer gets an honest pick-time notice. Original bytes
// are kept for every lane. Async because PDF/Office extraction is async.
export async function ingestPickedFiles(
  convId: string,
  filePaths: string[],
  existingCount: number
): Promise<{ picked: PickedAttachment[]; errors: string[] }> {
  assertValidConversationId(convId)
  const userData = app.getPath('userData')
  const dir = attachmentPath(userData, convId, '')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const picked: PickedAttachment[] = []
  const errors: string[] = []
  for (const filePath of filePaths) {
    const name = basename(filePath)

    // SECURITY (resource exhaustion): stat the file BEFORE ever reading it
    // into memory. An over-cap file must be rejected here, not after a full
    // readFileSync -- classifyPicked below also does a full-buffer
    // bytes.toString('latin1') for the OOXML zip peek, so refusing to read an
    // oversize file at all is the only way to keep its bytes out of memory
    // entirely (both the raw read AND that classify pass).
    let size: number
    try {
      size = statSync(filePath).size
    } catch {
      errors.push(`Could not read ${name}.`)
      continue
    }
    const preReadLimitError = checkPickLimits(existingCount + picked.length, size)
    if (preReadLimitError) {
      errors.push(`${name}: ${preReadLimitError}`)
      continue
    }

    let bytes: Buffer
    try {
      bytes = readFileSync(filePath)
    } catch {
      errors.push(`Could not read ${name}.`)
      continue
    }
    // Defense-in-depth: re-check against the bytes actually read, in case the
    // file changed on disk between the stat and the read (TOCTOU).
    const postReadLimitError = checkPickLimits(existingCount + picked.length, bytes.length)
    if (postReadLimitError) {
      errors.push(`${name}: ${postReadLimitError}`)
      continue
    }
    const classified = classifyPicked(bytes, name)
    if (!classified) {
      errors.push(`${name} is not a supported file (image, text/code, PDF, docx, or xlsx).`)
      continue
    }
    const { kind, mime } = classified
    const id = randomUUID()
    writeFileSync(attachmentPath(userData, convId, id), bytes)

    if (kind === 'image') {
      picked.push({
        ref: { id, name, mime, kind },
        previewDataUrl: `data:${mime};base64,${bytes.toString('base64')}`
      })
      continue
    }

    // Non-image: extract, write the text sidecar, surface the notice.
    let result: ExtractResult
    if (kind === 'text') result = extractTextLane(bytes)
    else if (kind === 'pdf') result = await runPdfExtraction(bytes)
    else result = await runOfficeExtraction(mime, bytes)
    writeFileSync(sidecarPath(userData, convId, id), result.text)
    picked.push({
      ref: { id, name, mime, kind },
      previewDataUrl: '',
      notice: result.badge + (result.notice ? ` · ${result.notice}` : '')
    })
  }
  return { picked, errors }
}

// Read a copied attachment back as base64, for the multimodal turn content
// (graph.ts). Returns null if the file is gone (deleted since attach). PURE
// path build; the only IO is the read.
export function readAttachmentBase64(convId: string, id: string): string | null {
  assertValidConversationId(convId)
  const p = attachmentPath(app.getPath('userData'), convId, id)
  try {
    return readFileSync(p).toString('base64')
  } catch {
    return null
  }
}

// The text sidecar for a non-image attachment: the same validated path
// segments as the bytes, with a .txt suffix (design 4/8).
export function sidecarPath(userDataDir: string, convId: string, id: string): string {
  return attachmentPath(userDataDir, convId, id) + '.txt'
}

// Read a non-image attachment's cached extracted text for the turn (graph.ts).
// Returns null if the sidecar is gone. SECURITY: convId is validated exactly as
// readAttachmentBase64 does before it becomes a path.
export function readAttachmentSidecar(convId: string, id: string): string | null {
  assertValidConversationId(convId)
  const p = sidecarPath(app.getPath('userData'), convId, id)
  try {
    return readFileSync(p).toString('utf8')
  } catch {
    return null
  }
}

// Read a copied attachment back as a full data: URL, for a REAL transcript
// thumbnail (Task 7): a reloaded transcript only carries the persisted
// AttachmentRef (id/name/mime), not bytes, so the pill's <img> needs this IPC
// to fetch actual pixels from disk. SECURITY: both convId and id are renderer-
// supplied path segments here (convId from the open-conversation context, id
// from a persisted event) -- validate BOTH against their path-safe grammars
// BEFORE any read, throwing (which rejects the IPC promise) on a mismatch
// rather than ever touching the filesystem with an unvalidated segment. The
// mime is re-sniffed from bytes (never trusted from the caller) for the same
// reason ingest never trusts a file extension. Returns null only for the
// legitimate "file is gone" / "not a recognized image" cases.
export function readAttachmentDataUrl(convId: string, id: string): string | null {
  assertValidConversationId(convId)
  assertValidAttachmentId(id)
  const p = attachmentPath(app.getPath('userData'), convId, id)
  let bytes: Buffer
  try {
    bytes = readFileSync(p)
  } catch {
    return null
  }
  const mime = sniffImageMime(bytes)
  if (!mime) return null
  return `data:${mime};base64,${bytes.toString('base64')}`
}
