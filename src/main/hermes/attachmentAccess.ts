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
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

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

async function readDirectory(path: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(path)
  } catch (error) {
    if (isMissing(error)) throw unavailable()
    throw unverified()
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw unverified()
  return info
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

function hasSameIdentity(
  first: Awaited<ReturnType<typeof lstat>>,
  second: Awaited<ReturnType<typeof lstat>>
): boolean {
  return first.dev === second.dev && first.ino === second.ino
}

export function sanitizeAttachmentName(name: string): string {
  if (typeof name !== 'string') return 'attachment'
  const separator = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  const leaf = name.slice(separator + 1).replace(/^[a-z]:/i, '')
  const sanitized = leaf.replace(/[<>:"|?*\u0000-\u001f\u007f-\u009f]/g, '').replace(/[. ]+$/g, '')
  if (sanitized.length === 0 || /^\.+$/.test(sanitized)) return 'attachment'
  return WINDOWS_DEVICE_NAME.test(sanitized) ? `_${sanitized}` : sanitized
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
  const initialRoot = await readDirectory(root)
  const initialConversationDirectory = await readDirectory(conversationDirectory)
  const initialLeaf = await readRegularFile(path)

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
    if (
      !before.isFile() ||
      !hasSameIdentity(initialLeaf, before) ||
      initialLeaf.size !== before.size
    ) {
      throw unverified()
    }
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
    const finalRoot = await readDirectory(root)
    const finalConversationDirectory = await readDirectory(conversationDirectory)
    const finalPathInfo = await readRegularFile(path)
    if (
      !after.isFile() ||
      !hasSameIdentity(initialRoot, finalRoot) ||
      !hasSameIdentity(initialConversationDirectory, finalConversationDirectory) ||
      !hasSameIdentity(before, after) ||
      before.size !== after.size ||
      before.size !== attachment.sizeBytes ||
      observedSize !== attachment.sizeBytes ||
      !hasSameIdentity(initialLeaf, finalPathInfo) ||
      !hasSameIdentity(before, finalPathInfo) ||
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
