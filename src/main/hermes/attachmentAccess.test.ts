import { createHash } from 'crypto'
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Event, HermesAttachment } from '../../shared/types'
import { MAX_ATTACHMENT_BYTES } from '../attachments/ingest'
import { resolveStoredAttachmentPath } from './nativeFiles'
import {
  readVerifiedStoredAttachment,
  sanitizeAttachmentName,
  type AttachmentReadHooks
} from './attachmentAccess'

const roots: string[] = []
const conversationId = 'conv_123'
const attachmentId = 'att_123'

async function rootDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bearcode-attachment-access-'))
  roots.push(root)
  return root
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function attachment(bytes: Buffer, overrides: Partial<HermesAttachment> = {}): HermesAttachment {
  return {
    id: attachmentId,
    name: 'CAIRN_project_plan.md',
    mime: 'text/markdown',
    kind: 'document',
    sizeBytes: bytes.length,
    sha256: sha256(bytes),
    ...overrides
  }
}

function attachmentEvents(value: HermesAttachment): Event[] {
  return [{ id: 'evt_123', type: 'assistant_attachment', attachment: value }]
}

async function store(root: string, id: string, bytes: Buffer): Promise<string> {
  const path = resolveStoredAttachmentPath(root, conversationId, id)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
  return path
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('readVerifiedStoredAttachment', () => {
  it('returns the exact persisted metadata and verified bytes for its attachment event', async () => {
    const root = await rootDir()
    const bytes = Buffer.from('Cairn attachment bytes')
    const value = attachment(bytes)
    await store(root, value.id, bytes)

    const result = await readVerifiedStoredAttachment(
      root,
      conversationId,
      value.id,
      attachmentEvents(value)
    )

    expect(result.bytes).toEqual(bytes)
    expect(result.attachment).toEqual(value)
    expect(result.attachment).not.toBe(value)
    expect(Object.isFrozen(result.attachment)).toBe(true)
  })

  it('reports an unknown attachment ID as no longer available', async () => {
    const root = await rootDir()
    const bytes = Buffer.from('Cairn attachment bytes')
    await store(root, attachmentId, bytes)

    await expect(
      readVerifiedStoredAttachment(
        root,
        conversationId,
        'att_unknown',
        attachmentEvents(attachment(bytes))
      )
    ).rejects.toThrow('Attachment is no longer available')
  })

  it('does not authorize a stored attachment absent from the supplied conversation events', async () => {
    const root = await rootDir()
    const bytes = Buffer.from('Cairn attachment bytes')
    await store(root, attachmentId, bytes)

    await expect(
      readVerifiedStoredAttachment(root, conversationId, attachmentId, [])
    ).rejects.toThrow('Attachment is no longer available')
  })

  it('rejects invalid identifiers before resolving stored paths', async () => {
    await expect(
      readVerifiedStoredAttachment('/not-used', '../escape', attachmentId, [])
    ).rejects.toThrow(/conversationId/)
    await expect(
      readVerifiedStoredAttachment('/not-used', conversationId, '../escape', [])
    ).rejects.toThrow(/id/)
  })

  it('reports missing attachment root, conversation directory, and leaf as unavailable', async () => {
    const root = await rootDir()
    const bytes = Buffer.from('Cairn attachment bytes')
    const events = attachmentEvents(attachment(bytes))

    await expect(
      readVerifiedStoredAttachment(root, conversationId, attachmentId, events)
    ).rejects.toThrow('Attachment is no longer available')
    await mkdir(join(root, 'attachments'))
    await expect(
      readVerifiedStoredAttachment(root, conversationId, attachmentId, events)
    ).rejects.toThrow('Attachment is no longer available')
    await mkdir(join(root, 'attachments', conversationId))
    await expect(
      readVerifiedStoredAttachment(root, conversationId, attachmentId, events)
    ).rejects.toThrow('Attachment is no longer available')
  })

  it('rejects symlinked attachment roots, conversation directories, and leaves', async () => {
    const bytes = Buffer.from('Cairn attachment bytes')
    const events = attachmentEvents(attachment(bytes))

    const rootLink = await rootDir()
    const rootTarget = join(rootLink, 'root-target')
    await mkdir(rootTarget)
    await symlink(rootTarget, join(rootLink, 'attachments'))
    await expect(
      readVerifiedStoredAttachment(rootLink, conversationId, attachmentId, events)
    ).rejects.toThrow('Attachment could not be verified')

    const conversationLink = await rootDir()
    const conversationTarget = join(conversationLink, 'conversation-target')
    await mkdir(conversationTarget)
    await mkdir(join(conversationLink, 'attachments'))
    await symlink(conversationTarget, join(conversationLink, 'attachments', conversationId))
    await expect(
      readVerifiedStoredAttachment(conversationLink, conversationId, attachmentId, events)
    ).rejects.toThrow('Attachment could not be verified')

    const leafLink = await rootDir()
    const leafTarget = join(leafLink, 'leaf-target')
    await writeFile(leafTarget, bytes)
    const leaf = resolveStoredAttachmentPath(leafLink, conversationId, attachmentId)
    await mkdir(dirname(leaf), { recursive: true })
    await symlink(leafTarget, leaf)
    await expect(
      readVerifiedStoredAttachment(leafLink, conversationId, attachmentId, events)
    ).rejects.toThrow('Attachment could not be verified')
  })

  it('rejects a directory at the canonical leaf', async () => {
    const root = await rootDir()
    const bytes = Buffer.from('Cairn attachment bytes')
    const leaf = resolveStoredAttachmentPath(root, conversationId, attachmentId)
    await mkdir(leaf, { recursive: true })

    await expect(
      readVerifiedStoredAttachment(
        root,
        conversationId,
        attachmentId,
        attachmentEvents(attachment(bytes))
      )
    ).rejects.toThrow('Attachment could not be verified')
  })

  it('rejects bytes whose persisted size does not match', async () => {
    const root = await rootDir()
    const bytes = Buffer.from('Cairn attachment bytes')
    await store(root, attachmentId, bytes)

    await expect(
      readVerifiedStoredAttachment(
        root,
        conversationId,
        attachmentId,
        attachmentEvents(attachment(bytes, { sizeBytes: bytes.length - 1 }))
      )
    ).rejects.toThrow('Attachment could not be verified')
  })

  it('rejects bytes whose persisted SHA-256 does not match', async () => {
    const root = await rootDir()
    const bytes = Buffer.from('Cairn attachment bytes')
    await store(root, attachmentId, bytes)

    await expect(
      readVerifiedStoredAttachment(
        root,
        conversationId,
        attachmentId,
        attachmentEvents(attachment(bytes, { sha256: '0'.repeat(64) }))
      )
    ).rejects.toThrow('Attachment could not be verified')
  })

  it('reads a file of exactly 10 MiB', async () => {
    const root = await rootDir()
    const bytes = Buffer.alloc(MAX_ATTACHMENT_BYTES, 0x61)
    const value = attachment(bytes)
    await store(root, attachmentId, bytes)

    const result = await readVerifiedStoredAttachment(
      root,
      conversationId,
      attachmentId,
      attachmentEvents(value)
    )

    expect(result.bytes).toHaveLength(MAX_ATTACHMENT_BYTES)
    expect(result.bytes[0]).toBe(0x61)
    expect(result.bytes.at(-1)).toBe(0x61)
    expect(result.attachment).toEqual(value)
  })

  it('rejects a file one byte above 10 MiB', async () => {
    const root = await rootDir()
    const bytes = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0x61)
    await store(root, attachmentId, bytes)

    await expect(
      readVerifiedStoredAttachment(
        root,
        conversationId,
        attachmentId,
        attachmentEvents(attachment(bytes))
      )
    ).rejects.toThrow('Attachment is too large')
  })

  it('rejects a canonical leaf replacement after opening its descriptor', async () => {
    const root = await rootDir()
    const bytes = Buffer.from('original verified bytes')
    const leaf = await store(root, attachmentId, bytes)
    const hooks: AttachmentReadHooks = {
      afterOpen: async () => {
        const replacement = join(dirname(leaf), 'att_replacement')
        await writeFile(replacement, 'replacement bytes')
        await rename(replacement, leaf)
      }
    }

    await expect(
      readVerifiedStoredAttachment(
        root,
        conversationId,
        attachmentId,
        attachmentEvents(attachment(bytes)),
        hooks
      )
    ).rejects.toThrow('Attachment could not be verified')
  })
})

describe('sanitizeAttachmentName', () => {
  it('keeps only the leaf name', () => {
    expect(sanitizeAttachmentName('../../CAIRN.md')).toBe('CAIRN.md')
  })

  it('keeps only the leaf name after Windows separators', () => {
    expect(sanitizeAttachmentName('C:\\unsafe\\report.pdf')).toBe('report.pdf')
  })

  it('removes a Windows drive-relative prefix from a leaf name', () => {
    expect(sanitizeAttachmentName('C:report.pdf')).toBe('report.pdf')
  })

  it('treats backslashes as separators and removes control characters from the leaf', () => {
    expect(sanitizeAttachmentName('CAIRN\\project\u0000plan.md')).toBe('projectplan.md')
  })

  it('falls back when sanitization leaves no usable name', () => {
    expect(sanitizeAttachmentName('...')).toBe('attachment')
    expect(sanitizeAttachmentName('\u0000')).toBe('attachment')
  })
})
