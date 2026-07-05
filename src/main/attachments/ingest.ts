// Main-side image-attachment ingest (D4 design 8/10). Bytes are copied to
// userData/attachments/<convId>/<id> at pick time and NEVER executed; the mime
// is sniffed from the leading bytes (magic numbers), NOT the file extension
// (design 10). png/jpg/webp/gif only; PDFs are out of scope for D4. Caps:
// 10 MB per file, 5 attachments per message.
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { app } from 'electron'
import { ATTACHMENT_MIME_TYPES, type AttachmentRef } from '../../shared/types'

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
function assertValidConversationId(conversationId: string): void {
  if (typeof conversationId !== 'string' || !CONVERSATION_ID_PATTERN.test(conversationId)) {
    throw new Error('attachments: conversationId must match /^[A-Za-z0-9_-]{1,64}$/')
  }
}

export interface PickedAttachment {
  ref: AttachmentRef
  // A data: URL of the copied image, for the composer thumbnail pill only.
  // Not persisted and not sent to the model (the model gets fresh base64 from
  // the copied file at turn time).
  previewDataUrl: string
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
    return `You can attach at most ${MAX_ATTACHMENTS_PER_MESSAGE} images per message.`
  }
  if (sizeBytes > MAX_ATTACHMENT_BYTES) {
    return `Image is larger than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB.`
  }
  return null
}

// Read, sniff, cap-check, and copy each picked file. Returns the accepted
// attachments (with previews) and a human-readable error per rejected file.
// Enforces the 5-per-message cap against the RUNNING total (existingCount +
// accepted so far), so a single multi-select pick can't overflow it.
export function ingestPickedFiles(
  convId: string,
  filePaths: string[],
  existingCount: number
): { picked: PickedAttachment[]; errors: string[] } {
  assertValidConversationId(convId)
  const dir = attachmentPath(app.getPath('userData'), convId, '')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const picked: PickedAttachment[] = []
  const errors: string[] = []
  for (const filePath of filePaths) {
    const name = basename(filePath)
    let bytes: Buffer
    try {
      bytes = readFileSync(filePath)
    } catch {
      errors.push(`Could not read ${name}.`)
      continue
    }
    const mime = sniffImageMime(bytes)
    if (!mime) {
      errors.push(`${name} is not a supported image (png, jpg, webp, gif).`)
      continue
    }
    const limitError = checkPickLimits(existingCount + picked.length, bytes.length)
    if (limitError) {
      errors.push(`${name}: ${limitError}`)
      continue
    }
    const id = randomUUID()
    writeFileSync(attachmentPath(app.getPath('userData'), convId, id), bytes)
    picked.push({
      ref: { id, name, mime },
      previewDataUrl: `data:${mime};base64,${bytes.toString('base64')}`
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
