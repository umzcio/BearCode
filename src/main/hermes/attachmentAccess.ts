import { createHash, timingSafeEqual } from 'crypto'
import { constants } from 'fs'
import { lstat, open } from 'fs/promises'
import { dirname } from 'path'
import type { Event, HermesAttachment } from '../../shared/types'
import {
  assertValidAttachmentId,
  assertValidConversationId,
  MAX_ATTACHMENT_BYTES
} from '../attachments/ingest'
import { resolveStoredAttachmentPath } from './nativeFiles'

export interface VerifiedStoredAttachment {
  attachment: Readonly<HermesAttachment>
  bytes: Buffer
}

export interface AttachmentReadHooks {
  afterOpen?: () => Promise<void> | void
}

const UNAVAILABLE = 'Attachment is no longer available'
const UNVERIFIED = 'Attachment could not be verified'
const TOO_LARGE = 'Attachment is too large'
const SHA256_BYTES = 32
const READ_CHUNK_BYTES = 64 * 1024

function unavailable(): Error {
  return new Error(UNAVAILABLE)
}

function unverified(): Error {
  return new Error(UNVERIFIED)
}

function tooLarge(): Error {
  return new Error(TOO_LARGE)
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

async function readDirectory(path: string): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(path)
  } catch (error) {
    if (isMissing(error)) throw unavailable()
    throw unverified()
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw unverified()
}

async function readRegularFile(path: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isFile()) throw unverified()
    return info
  } catch (error) {
    if (isMissing(error)) throw unavailable()
    throw error instanceof Error && error.message === UNVERIFIED ? error : unverified()
  }
}

function findAttachment(
  events: readonly Event[],
  attachmentId: string
): HermesAttachment | undefined {
  for (const event of events) {
    if (event.type === 'assistant_attachment' && event.attachment.id === attachmentId) {
      return event.attachment
    }
  }
  return undefined
}

function sha256Matches(actual: Buffer, expectedHex: string): boolean {
  const expected = Buffer.alloc(SHA256_BYTES)
  const valid = typeof expectedHex === 'string' && /^[a-f0-9]{64}$/i.test(expectedHex)
  if (valid) Buffer.from(expectedHex, 'hex').copy(expected)
  return timingSafeEqual(actual, expected) && valid
}

function immutableMetadataSnapshot(attachment: HermesAttachment): Readonly<HermesAttachment> {
  return Object.freeze({
    id: attachment.id,
    name: attachment.name,
    mime: attachment.mime,
    kind: attachment.kind,
    sizeBytes: attachment.sizeBytes,
    sha256: attachment.sha256
  })
}

export function sanitizeAttachmentName(name: string): string {
  if (typeof name !== 'string') return 'attachment'
  const leaf = name.slice(name.lastIndexOf('/') + 1)
  const sanitized = leaf.replace(/[\\\u0000-\u001f\u007f-\u009f]/g, '')
  return sanitized.length === 0 || /^\.+$/.test(sanitized) ? 'attachment' : sanitized
}

export async function readVerifiedStoredAttachment(
  userDataDir: string,
  conversationId: string,
  attachmentId: string,
  events: readonly Event[],
  hooks: AttachmentReadHooks = {}
): Promise<VerifiedStoredAttachment> {
  assertValidConversationId(conversationId)
  assertValidAttachmentId(attachmentId)

  const attachment = findAttachment(events, attachmentId)
  if (!attachment) throw unavailable()

  const path = resolveStoredAttachmentPath(userDataDir, conversationId, attachmentId)
  const conversationDirectory = dirname(path)
  const root = dirname(conversationDirectory)
  await readDirectory(root)
  await readDirectory(conversationDirectory)
  await readRegularFile(path)

  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if (isMissing(error)) throw unavailable()
      throw unverified()
    }

    const before = await handle.stat().catch(() => {
      throw unverified()
    })
    if (!before.isFile()) throw unverified()
    if (before.size > MAX_ATTACHMENT_BYTES) throw tooLarge()

    await hooks.afterOpen?.()

    const hash = createHash('sha256')
    const chunks: Buffer[] = []
    let observedSize = 0
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null).catch(() => {
        throw unverified()
      })
      if (bytesRead === 0) break
      const chunk = Buffer.from(buffer.subarray(0, bytesRead))
      observedSize += chunk.length
      if (observedSize > MAX_ATTACHMENT_BYTES) throw tooLarge()
      hash.update(chunk)
      chunks.push(chunk)
    }

    const after = await handle.stat().catch(() => {
      throw unverified()
    })
    const finalPathInfo = await readRegularFile(path)
    if (
      !after.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.size !== attachment.sizeBytes ||
      observedSize !== attachment.sizeBytes ||
      finalPathInfo.dev !== before.dev ||
      finalPathInfo.ino !== before.ino ||
      finalPathInfo.size !== observedSize
    ) {
      throw unverified()
    }

    const digest = hash.digest()
    if (!sha256Matches(digest, attachment.sha256)) throw unverified()

    return { attachment: immutableMetadataSnapshot(attachment), bytes: Buffer.concat(chunks) }
  } finally {
    await handle?.close()
  }
}
