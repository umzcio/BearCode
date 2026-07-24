import { createHash, randomUUID, timingSafeEqual } from 'crypto'
import { constants } from 'fs'
import { link, lstat, mkdir, open, rm, unlink } from 'fs/promises'
import { dirname, resolve } from 'path'
import type { AttachmentRef, HermesAttachment, HermesAttachmentKind } from '../../shared/types'
import {
  assertValidAttachmentId,
  assertValidConversationId,
  MAX_ATTACHMENT_BYTES
} from '../attachments/ingest'

export interface NativeUploadDescription {
  id: string
  name: string
  declaredMime: string
  kind: HermesAttachmentKind
  sizeBytes: number
  sha256: string
  path: string
}

interface ActiveDownload {
  attachment: HermesAttachment
  partialPath: string
  handle: Awaited<ReturnType<typeof open>>
  bytesWritten: number
  nextChunkIndex: number
  hash: ReturnType<typeof createHash>
}

function attachmentRoot(userDataDir: string): string {
  if (typeof userDataDir !== 'string' || userDataDir.length === 0) {
    throw new Error('attachments: userDataDir must be a non-empty path')
  }
  const root = resolve(userDataDir)
  const result = resolve(root, 'attachments')
  if (dirname(result) !== root) throw new Error('attachments: invalid attachment root')
  return result
}

function conversationDirectory(userDataDir: string, conversationId: string): string {
  assertValidConversationId(conversationId)
  const root = attachmentRoot(userDataDir)
  const result = resolve(root, conversationId)
  if (dirname(result) !== root)
    throw new Error('attachments: conversation directory escaped attachment root')
  return result
}

// The one canonical location for stored bytes. Keep this path construction
// independent of caller-provided filenames: only validated opaque IDs may
// become path segments.
export function resolveStoredAttachmentPath(
  userDataDir: string,
  conversationId: string,
  id: string
): string {
  assertValidAttachmentId(id)
  const directory = conversationDirectory(userDataDir, conversationId)
  const result = resolve(directory, id)
  if (dirname(result) !== directory)
    throw new Error('attachments: attachment path escaped conversation directory')
  return result
}

function nativeKind(kind: AttachmentRef['kind']): HermesAttachmentKind {
  if (kind === undefined) return 'image'
  if (kind === 'image') return 'image'
  if (kind === 'text') return 'text'
  if (kind === 'pdf' || kind === 'office') return 'document'
  return 'other'
}

function assertAttachmentMetadata(attachment: HermesAttachment): void {
  assertValidAttachmentId(attachment.id)
  if (typeof attachment.name !== 'string' || typeof attachment.mime !== 'string') {
    throw new Error('attachments: attachment name and mime must be strings')
  }
  if (!['image', 'document', 'text', 'other'].includes(attachment.kind)) {
    throw new Error('attachments: invalid attachment kind')
  }
  if (
    !Number.isInteger(attachment.sizeBytes) ||
    attachment.sizeBytes < 0 ||
    attachment.sizeBytes > MAX_ATTACHMENT_BYTES
  ) {
    throw new Error('attachments: size must be between 0 and 10 MiB')
  }
  if (!/^[a-f0-9]{64}$/i.test(attachment.sha256)) {
    throw new Error('attachments: sha256 must be a 64-character hex digest')
  }
}

function immutableMetadataSnapshot(attachment: HermesAttachment): HermesAttachment {
  return Object.freeze({
    id: attachment.id,
    name: attachment.name,
    mime: attachment.mime,
    kind: attachment.kind,
    sizeBytes: attachment.sizeBytes,
    sha256: attachment.sha256
  })
}

async function assertRealDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`attachments: ${label} must be a non-symbolic directory`)
  }
}

async function ensureConversationDirectory(
  userDataDir: string,
  conversationId: string
): Promise<string> {
  const root = attachmentRoot(userDataDir)
  await mkdir(root, { recursive: true, mode: 0o700 })
  await assertRealDirectory(root, 'attachment root')
  const directory = conversationDirectory(userDataDir, conversationId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await assertRealDirectory(directory, 'conversation directory')
  return directory
}

async function assertStoredFileParent(userDataDir: string, conversationId: string): Promise<void> {
  const root = attachmentRoot(userDataDir)
  await assertRealDirectory(root, 'attachment root')
  await assertRealDirectory(
    conversationDirectory(userDataDir, conversationId),
    'conversation directory'
  )
}

// Opens only a verified stored file and hashes the exact opened descriptor.
// The cap is enforced by lstat, the descriptor's initial/final stats, and the
// bytes observed by the stream so an in-place growth cannot evade the limit.
export async function describeNativeUpload(
  userDataDir: string,
  conversationId: string,
  ref: AttachmentRef
): Promise<NativeUploadDescription> {
  assertValidConversationId(conversationId)
  assertValidAttachmentId(ref.id)
  const path = resolveStoredAttachmentPath(userDataDir, conversationId, ref.id)
  await assertStoredFileParent(userDataDir, conversationId)
  const pathInfo = await lstat(path)
  if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) {
    throw new Error('attachments: stored attachment must be a regular non-symbolic file')
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = await handle.stat()
    if (!before.isFile()) throw new Error('attachments: stored attachment must be a regular file')
    if (before.size > MAX_ATTACHMENT_BYTES)
      throw new Error('attachments: stored attachment exceeds 10 MiB')

    const hash = createHash('sha256')
    let sizeBytes = 0
    const stream = handle.createReadStream({ autoClose: false })
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      sizeBytes += bytes.length
      if (sizeBytes > MAX_ATTACHMENT_BYTES) {
        stream.destroy()
        throw new Error('attachments: stored attachment exceeds 10 MiB')
      }
      hash.update(bytes)
    }
    const after = await handle.stat()
    // The descriptor can remain valid after a pathname replacement. Re-lstat
    // the canonical leaf as well, so the returned path still names the exact
    // inode that was stream-hashed.
    const finalPathInfo = await lstat(path)
    if (
      !after.isFile() ||
      finalPathInfo.isSymbolicLink() ||
      !finalPathInfo.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.size !== sizeBytes ||
      finalPathInfo.dev !== before.dev ||
      finalPathInfo.ino !== before.ino ||
      finalPathInfo.size !== sizeBytes
    ) {
      throw new Error('attachments: stored attachment changed while reading')
    }

    return {
      id: ref.id,
      name: ref.name,
      declaredMime: ref.mime,
      kind: nativeKind(ref.kind),
      sizeBytes,
      sha256: hash.digest('hex'),
      path
    }
  } finally {
    await handle?.close()
  }
}

async function removePartial(active: ActiveDownload): Promise<void> {
  try {
    await active.handle.close()
  } catch {
    // Closing an already-closed descriptor must not prevent cleanup.
  }
  await unlink(active.partialPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
}

export class NativeDownloadWriter {
  private readonly active = new Map<string, ActiveDownload>()
  private readonly reserved = new Set<string>()
  private operations: Promise<void> = Promise.resolve()

  constructor(
    private readonly userDataDir: string,
    private readonly conversationId: string
  ) {
    assertValidConversationId(conversationId)
    attachmentRoot(userDataDir)
  }

  async begin(attachment: HermesAttachment): Promise<void> {
    assertAttachmentMetadata(attachment)
    if (this.active.has(attachment.id) || this.reserved.has(attachment.id)) {
      throw new Error('attachments: duplicate active attachment id')
    }
    this.reserved.add(attachment.id)
    // The wire event object belongs to the WebSocket parser/caller. Capture
    // exactly the persisted fields so later caller mutation cannot alter the
    // ID, verification constraints, or transcript metadata.
    const metadata: HermesAttachment = {
      id: attachment.id,
      name: attachment.name,
      mime: attachment.mime,
      kind: attachment.kind,
      sizeBytes: attachment.sizeBytes,
      sha256: attachment.sha256
    }
    return this.enqueue(async () => {
      let began = false
      try {
        const directory = await ensureConversationDirectory(this.userDataDir, this.conversationId)
        const finalPath = resolveStoredAttachmentPath(
          this.userDataDir,
          this.conversationId,
          metadata.id
        )
        try {
          await lstat(finalPath)
          throw new Error('attachments: duplicate stored attachment id')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }

        const partialPath = resolve(directory, `.partial-${randomUUID()}`)
        if (dirname(partialPath) !== directory)
          throw new Error('attachments: partial path escaped conversation directory')
        let handle: Awaited<ReturnType<typeof open>> | undefined
        try {
          handle = await open(
            partialPath,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
            0o600
          )
          this.active.set(metadata.id, {
            attachment: metadata,
            partialPath,
            handle,
            bytesWritten: 0,
            nextChunkIndex: 0,
            hash: createHash('sha256')
          })
          began = true
        } catch (error) {
          await handle?.close().catch(() => undefined)
          await unlink(partialPath).catch(() => undefined)
          throw error
        }
      } finally {
        if (!began) this.reserved.delete(metadata.id)
      }
    })
  }

  append(attachmentId: string, chunkIndex: number, payload: Buffer): Promise<void> {
    return this.enqueue(async () => {
      const active = this.active.get(attachmentId)
      if (!active) throw new Error('attachments: unknown download attachment id')
      if (!Number.isInteger(chunkIndex) || chunkIndex !== active.nextChunkIndex) {
        await this.fail(
          attachmentId,
          active,
          new Error('attachments: download chunks must be contiguous')
        )
      }
      if (!Buffer.isBuffer(payload)) {
        await this.fail(
          attachmentId,
          active,
          new Error('attachments: download chunk must be a Buffer')
        )
      }
      if (
        active.bytesWritten + payload.length > MAX_ATTACHMENT_BYTES ||
        active.bytesWritten + payload.length > active.attachment.sizeBytes
      ) {
        await this.fail(
          attachmentId,
          active,
          new Error('attachments: download exceeds declared size or 10 MiB cap')
        )
      }
      try {
        let offset = 0
        while (offset < payload.length) {
          const { bytesWritten } = await active.handle.write(
            payload,
            offset,
            payload.length - offset,
            active.bytesWritten + offset
          )
          if (bytesWritten <= 0) throw new Error('attachments: failed to write download chunk')
          offset += bytesWritten
        }
        active.bytesWritten += payload.length
        active.nextChunkIndex += 1
        active.hash.update(payload)
      } catch (error) {
        await this.fail(
          attachmentId,
          active,
          error instanceof Error ? error : new Error(String(error))
        )
      }
    })
  }

  complete(attachmentId: string): Promise<HermesAttachment> {
    return this.enqueue(async () => {
      const active = this.active.get(attachmentId)
      if (!active) throw new Error('attachments: unknown download attachment id')
      try {
        if (active.bytesWritten !== active.attachment.sizeBytes) {
          throw new Error('attachments: downloaded size does not match declared size')
        }
        const digest = active.hash.digest()
        const expected = Buffer.from(active.attachment.sha256, 'hex')
        if (digest.length !== expected.length || !timingSafeEqual(digest, expected)) {
          throw new Error('attachments: downloaded SHA-256 does not match declared digest')
        }
        await active.handle.sync()
        await active.handle.close()
        const finalPath = resolveStoredAttachmentPath(
          this.userDataDir,
          this.conversationId,
          attachmentId
        )
        try {
          await lstat(finalPath)
          throw new Error('attachments: duplicate stored attachment id')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        // `rename` replaces an existing target on Unix. `link` is the atomic
        // no-clobber publication primitive: partial and final live in this same
        // conversation directory (and therefore the same filesystem), so it
        // creates the final name only if absent, then the staging name is
        // unlinked. The verified inode is never observable at the final path
        // until this operation succeeds.
        await link(active.partialPath, finalPath)
        await unlink(active.partialPath)
        this.active.delete(attachmentId)
        this.reserved.delete(attachmentId)
        return immutableMetadataSnapshot(active.attachment)
      } catch (error) {
        this.active.delete(attachmentId)
        this.reserved.delete(attachmentId)
        await removePartial(active)
        throw error
      }
    })
  }

  abort(attachmentId?: string): Promise<void> {
    return this.enqueue(async () => {
      const entries =
        attachmentId === undefined
          ? [...this.active.entries()]
          : this.active.has(attachmentId)
            ? [[attachmentId, this.active.get(attachmentId)!] as const]
            : []
      await Promise.all(
        entries.map(async ([id, active]) => {
          this.active.delete(id)
          this.reserved.delete(id)
          await removePartial(active)
        })
      )
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation)
    this.operations = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async fail(attachmentId: string, active: ActiveDownload, error: Error): Promise<never> {
    this.active.delete(attachmentId)
    this.reserved.delete(attachmentId)
    await removePartial(active)
    throw error
  }
}

export async function deleteConversationAttachments(
  userDataDir: string,
  conversationId: string
): Promise<void> {
  assertValidConversationId(conversationId)
  const root = attachmentRoot(userDataDir)
  try {
    await assertRealDirectory(root, 'attachment root')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const directory = conversationDirectory(userDataDir, conversationId)
  try {
    await assertRealDirectory(directory, 'conversation directory')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 2 })
}

export async function openAttachment(
  userDataDir: string,
  conversationId: string,
  attachmentId: string,
  openPath: (path: string) => Promise<string>
): Promise<void> {
  const path = resolveStoredAttachmentPath(userDataDir, conversationId, attachmentId)
  await assertStoredFileParent(userDataDir, conversationId)
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error('attachments: stored attachment must be a regular non-symbolic file')
  }
  // Re-open with O_NOFOLLOW and fstat the descriptor, not just the pathname.
  // The shell cannot receive this caller-addressable canonical leaf: after
  // validation, another process could replace that pathname before the shell
  // consumes it. Instead, copy the opened descriptor to a private,
  // unpredictable application-owned directory and give the shell that copy.
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let snapshotDirectory: string | undefined
  let snapshotPath: string | undefined
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const descriptorInfo = await handle.stat()
    if (!descriptorInfo.isFile()) {
      throw new Error('attachments: stored attachment must be a regular file')
    }
    const root = attachmentRoot(userDataDir)
    snapshotDirectory = resolve(root, `.open-${randomUUID()}`)
    if (dirname(snapshotDirectory) !== root)
      throw new Error('attachments: snapshot directory escaped attachment root')
    await mkdir(snapshotDirectory, { mode: 0o700 })
    await assertRealDirectory(snapshotDirectory, 'open snapshot directory')
    snapshotPath = resolve(snapshotDirectory, 'attachment')
    if (dirname(snapshotPath) !== snapshotDirectory)
      throw new Error('attachments: snapshot path escaped snapshot directory')

    let snapshot: Awaited<ReturnType<typeof open>> | undefined
    try {
      snapshot = await open(
        snapshotPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      )
      const buffer = Buffer.allocUnsafe(64 * 1024)
      let position = 0
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
        if (bytesRead === 0) break
        let offset = 0
        while (offset < bytesRead) {
          const { bytesWritten } = await snapshot.write(
            buffer,
            offset,
            bytesRead - offset,
            position + offset
          )
          if (bytesWritten <= 0) throw new Error('attachments: failed to write open snapshot')
          offset += bytesWritten
        }
        position += bytesRead
      }
      await snapshot.sync()
    } finally {
      await snapshot?.close()
    }
  } catch (error) {
    if (snapshotDirectory) await rm(snapshotDirectory, { recursive: true, force: true })
    throw error
  } finally {
    await handle?.close()
  }
  try {
    const result = await openPath(snapshotPath!)
    if (result) throw new Error(`Could not open attachment: ${result}`)
  } finally {
    // shell.openPath has accepted the stable file before resolving. The copy is
    // only an open handoff and is removed on both success and failure.
    await rm(snapshotDirectory!, { recursive: true, force: true })
  }
}
