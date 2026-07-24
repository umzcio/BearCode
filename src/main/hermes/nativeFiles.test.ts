import { createHash } from 'crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AttachmentRef, HermesAttachment } from '../../shared/types'
import {
  NativeDownloadWriter,
  deleteConversationAttachments,
  describeNativeUpload,
  openAttachment,
  resolveStoredAttachmentPath
} from './nativeFiles'

const roots: string[] = []

async function rootDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bearcode-native-files-'))
  roots.push(root)
  return root
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function attachment(overrides: Partial<HermesAttachment> = {}): HermesAttachment {
  const bytes = Buffer.from('data')
  return {
    id: 'a1',
    name: 'note.txt',
    mime: 'text/plain',
    kind: 'text',
    sizeBytes: bytes.length,
    sha256: sha256(bytes),
    ...overrides
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('describeNativeUpload', () => {
  it('describes a regular stored file with an incremental SHA-256 digest', async () => {
    const root = await rootDir()
    const path = resolveStoredAttachmentPath(root, 'c1', 'a1')
    await mkdir(join(root, 'attachments', 'c1'), { recursive: true })
    await writeFile(path, Buffer.from([1, 2, 3, 4]))
    const ref: AttachmentRef = { id: 'a1', name: 'note.txt', mime: 'text/plain', kind: 'text' }

    await expect(describeNativeUpload(root, 'c1', ref)).resolves.toEqual({
      id: 'a1',
      name: 'note.txt',
      declaredMime: 'text/plain',
      kind: 'text',
      sizeBytes: 4,
      sha256: '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a',
      path: expect.stringContaining('/attachments/c1/a1')
    })
  })

  it('defaults a legacy attachment with no kind to image', async () => {
    const root = await rootDir()
    const path = resolveStoredAttachmentPath(root, 'c1', 'a1')
    await mkdir(join(root, 'attachments', 'c1'), { recursive: true })
    await writeFile(path, 'data')
    const ref = { id: 'a1', name: 'legacy.png', mime: 'image/png' } as AttachmentRef

    await expect(describeNativeUpload(root, 'c1', ref)).resolves.toMatchObject({ kind: 'image' })
  })

  it('rejects traversal identifiers before resolving a path', async () => {
    const root = await rootDir()
    const ref: AttachmentRef = { id: '../a1', name: 'note.txt', mime: 'text/plain', kind: 'text' }

    await expect(describeNativeUpload(root, '../c1', ref)).rejects.toThrow(/conversationId/)
    await expect(describeNativeUpload(root, 'c1', ref)).rejects.toThrow(/id/)
  })

  it('rejects a missing stored file', async () => {
    const root = await rootDir()
    const ref: AttachmentRef = { id: 'a1', name: 'note.txt', mime: 'text/plain', kind: 'text' }

    await expect(describeNativeUpload(root, 'c1', ref)).rejects.toThrow()
  })

  it('rejects files whose current size exceeds the 10 MiB cap', async () => {
    const root = await rootDir()
    const path = resolveStoredAttachmentPath(root, 'c1', 'a1')
    await mkdir(join(root, 'attachments', 'c1'), { recursive: true })
    await writeFile(path, Buffer.alloc(10 * 1024 * 1024 + 1))
    const ref: AttachmentRef = { id: 'a1', name: 'note.txt', mime: 'text/plain', kind: 'text' }

    await expect(describeNativeUpload(root, 'c1', ref)).rejects.toThrow(/10 MiB/)
  })

  it('rejects a symbolic link instead of streaming outside the attachment store', async () => {
    const root = await rootDir()
    const outside = join(root, 'outside.txt')
    const path = resolveStoredAttachmentPath(root, 'c1', 'a1')
    await writeFile(outside, 'data')
    await mkdir(join(root, 'attachments', 'c1'), { recursive: true })
    await symlink(outside, path)
    const ref: AttachmentRef = { id: 'a1', name: 'note.txt', mime: 'text/plain', kind: 'text' }

    await expect(describeNativeUpload(root, 'c1', ref)).rejects.toThrow(/regular|symbolic/i)
  })
})

describe('NativeDownloadWriter', () => {
  it('atomically completes a verified download at the exact attachment path with mode 0600', async () => {
    const root = await rootDir()
    const writer = new NativeDownloadWriter(root, 'c1')
    const value = attachment()

    await writer.begin(value)
    await writer.append(value.id, 0, Buffer.from('data'))
    const path = resolveStoredAttachmentPath(root, 'c1', value.id)
    await expect(readFile(path)).rejects.toThrow()
    await expect(writer.complete(value.id)).resolves.toEqual(value)
    expect(await readFile(path, 'utf8')).toBe('data')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readdir(join(root, 'attachments', 'c1'))).toEqual(['a1'])
  })

  it('requires contiguous chunk indexes', async () => {
    const root = await rootDir()
    const writer = new NativeDownloadWriter(root, 'c1')
    const value = attachment()
    await writer.begin(value)

    await expect(writer.append(value.id, 1, Buffer.from('data'))).rejects.toThrow(/chunk/i)
    await expect(readdir(join(root, 'attachments', 'c1'))).resolves.toEqual([])
  })

  it('serializes concurrent same-index appends and cleans the conflicted transfer', async () => {
    const root = await rootDir()
    const writer = new NativeDownloadWriter(root, 'c1')
    const value = attachment({ sizeBytes: 2, sha256: sha256('aa') })
    await writer.begin(value)

    const outcomes = await Promise.all([
      writer.append(value.id, 0, Buffer.from('a')).then(
        () => 'first fulfilled',
        () => 'first rejected'
      ),
      writer.append(value.id, 0, Buffer.from('a')).then(
        () => 'second fulfilled',
        () => 'second rejected'
      )
    ])

    expect(outcomes).toEqual(['first fulfilled', 'second rejected'])
    await expect(readdir(join(root, 'attachments', 'c1'))).resolves.toEqual([])
  })

  it('serializes an append before a concurrently requested completion', async () => {
    const root = await rootDir()
    const writer = new NativeDownloadWriter(root, 'c1')
    const value = attachment()
    await writer.begin(value)

    const [, completed] = await Promise.all([
      writer.append(value.id, 0, Buffer.from('data')),
      writer.complete(value.id)
    ])

    expect(completed).toEqual(value)
    expect(await readFile(resolveStoredAttachmentPath(root, 'c1', value.id), 'utf8')).toBe('data')
  })

  it('serializes an append before a concurrently requested abort and cleans it up', async () => {
    const root = await rootDir()
    const writer = new NativeDownloadWriter(root, 'c1')
    const value = attachment()
    await writer.begin(value)

    await Promise.all([writer.append(value.id, 0, Buffer.from('data')), writer.abort(value.id)])

    await expect(readdir(join(root, 'attachments', 'c1'))).resolves.toEqual([])
  })

  it('removes the partial file when declared size is not met', async () => {
    const root = await rootDir()
    const writer = new NativeDownloadWriter(root, 'c1')
    const value = attachment({ sizeBytes: 5 })
    await writer.begin(value)
    await writer.append(value.id, 0, Buffer.from('data'))

    await expect(writer.complete(value.id)).rejects.toThrow(/size/i)
    await expect(readdir(join(root, 'attachments', 'c1'))).resolves.toEqual([])
  })

  it('removes the partial file when the declared digest does not match', async () => {
    const root = await rootDir()
    const writer = new NativeDownloadWriter(root, 'c1')
    const value = attachment({ sha256: '0'.repeat(64) })
    await writer.begin(value)
    await writer.append(value.id, 0, Buffer.from('data'))

    await expect(writer.complete(value.id)).rejects.toThrow(/hash|sha/i)
    await expect(readdir(join(root, 'attachments', 'c1'))).resolves.toEqual([])
  })

  it('rejects duplicate attachment IDs without replacing an active transfer', async () => {
    const root = await rootDir()
    const writer = new NativeDownloadWriter(root, 'c1')
    const value = attachment()
    await writer.begin(value)

    await expect(writer.begin(value)).rejects.toThrow(/duplicate|already/i)
    await writer.abort()
    await expect(readdir(join(root, 'attachments', 'c1'))).resolves.toEqual([])
  })

  it('reserves an attachment ID before concurrent begin calls can create two partials', async () => {
    const root = await rootDir()
    const writer = new NativeDownloadWriter(root, 'c1')
    const value = attachment()

    const outcomes = await Promise.all([
      writer.begin(value).then(
        () => 'first fulfilled',
        () => 'first rejected'
      ),
      writer.begin(value).then(
        () => 'second fulfilled',
        () => 'second rejected'
      )
    ])

    expect(outcomes).toEqual(['first fulfilled', 'second rejected'])
    await writer.abort()
    await expect(readdir(join(root, 'attachments', 'c1'))).resolves.toEqual([])
  })

  it('never overwrites an attachment that appears before final publication', async () => {
    const root = await rootDir()
    const writer = new NativeDownloadWriter(root, 'c1')
    const value = attachment()
    const finalPath = resolveStoredAttachmentPath(root, 'c1', value.id)
    await writer.begin(value)
    await writer.append(value.id, 0, Buffer.from('data'))
    await writeFile(finalPath, 'existing')

    await expect(writer.complete(value.id)).rejects.toThrow(/duplicate|already/i)
    expect(await readFile(finalPath, 'utf8')).toBe('existing')
  })

  it('abort removes every active partial file', async () => {
    const root = await rootDir()
    const writer = new NativeDownloadWriter(root, 'c1')
    const first = attachment({ id: 'a1' })
    const second = attachment({ id: 'a2' })
    await writer.begin(first)
    await writer.begin(second)

    await writer.abort()
    await expect(readdir(join(root, 'attachments', 'c1'))).resolves.toEqual([])
  })

  it('never uses a caller filename as a storage path', async () => {
    const root = await rootDir()
    const writer = new NativeDownloadWriter(root, 'c1')
    const value = attachment({ name: '../../outside.txt' })
    await writer.begin(value)
    await writer.append(value.id, 0, Buffer.from('data'))
    await writer.complete(value.id)

    await expect(readFile(join(root, 'outside.txt'))).rejects.toThrow()
    expect(await readFile(resolveStoredAttachmentPath(root, 'c1', value.id), 'utf8')).toBe('data')
  })

  it('uses an immutable metadata snapshot after begin', async () => {
    const root = await rootDir()
    const writer = new NativeDownloadWriter(root, 'c1')
    const value = attachment()
    const expected = { ...value }
    await writer.begin(value)
    value.id = 'a2'
    value.name = 'changed.txt'
    value.mime = 'application/octet-stream'
    value.kind = 'other'
    value.sizeBytes = 0
    value.sha256 = '0'.repeat(64)

    await writer.append(expected.id, 0, Buffer.from('data'))
    await expect(writer.complete(expected.id)).resolves.toEqual(expected)
    expect(await readFile(resolveStoredAttachmentPath(root, 'c1', expected.id), 'utf8')).toBe(
      'data'
    )
  })

  it('returns a frozen exact metadata snapshot after completion', async () => {
    const root = await rootDir()
    const writer = new NativeDownloadWriter(root, 'c1')
    const value = attachment()
    await writer.begin(value)
    await writer.append(value.id, 0, Buffer.from('data'))

    const completed = await writer.complete(value.id)

    expect(completed).not.toBe(value)
    expect(Object.keys(completed).sort()).toEqual([
      'id',
      'kind',
      'mime',
      'name',
      'sha256',
      'sizeBytes'
    ])
    expect(Object.isFrozen(completed)).toBe(true)
    expect(() => {
      completed.name = 'mutated.txt'
    }).toThrow()
    expect(completed.name).toBe('note.txt')
  })
})

describe('deleteConversationAttachments', () => {
  it('removes only the validated conversation directory', async () => {
    const root = await rootDir()
    await mkdir(join(root, 'attachments', 'c1'), { recursive: true })
    await mkdir(join(root, 'attachments', 'c2'), { recursive: true })
    await writeFile(join(root, 'attachments', 'c1', 'a1'), 'one')
    await writeFile(join(root, 'attachments', 'c2', 'a2'), 'two')

    await deleteConversationAttachments(root, 'c1')

    await expect(stat(join(root, 'attachments', 'c1'))).rejects.toThrow()
    expect(await readFile(join(root, 'attachments', 'c2', 'a2'), 'utf8')).toBe('two')
  })

  it('rejects a traversal conversation ID without deleting an attachment directory', async () => {
    const root = await rootDir()
    await mkdir(join(root, 'attachments', 'c1'), { recursive: true })
    await writeFile(join(root, 'attachments', 'c1', 'a1'), 'one')

    await expect(deleteConversationAttachments(root, '../c1')).rejects.toThrow(/conversationId/)
    expect(await readFile(join(root, 'attachments', 'c1', 'a1'), 'utf8')).toBe('one')
  })

  it('refuses to recursively remove a symlinked conversation directory', async () => {
    const root = await rootDir()
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'keep'), 'safe')
    await mkdir(join(root, 'attachments'), { recursive: true })
    await symlink(outside, join(root, 'attachments', 'c1'))

    await expect(deleteConversationAttachments(root, 'c1')).rejects.toThrow(/non-symbolic/i)
    expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('safe')
  })
})

describe('openAttachment', () => {
  it('hands the shell a cleaned-up snapshot whose bytes survive a canonical-path swap', async () => {
    const root = await rootDir()
    const path = resolveStoredAttachmentPath(root, 'c1', 'a1')
    await mkdir(join(root, 'attachments', 'c1'), { recursive: true })
    await writeFile(path, 'verified')
    let snapshotPath = ''

    await openAttachment(root, 'c1', 'a1', async (shellPath) => {
      snapshotPath = shellPath
      await writeFile(path, 'replacement')
      expect(shellPath).not.toBe(path)
      expect(await readFile(shellPath, 'utf8')).toBe('verified')
      return ''
    })

    await expect(readFile(snapshotPath)).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('replacement')
  })

  it('rejects a symlinked attachment before handing a path to the shell', async () => {
    const root = await rootDir()
    const outside = join(root, 'outside.txt')
    const path = resolveStoredAttachmentPath(root, 'c1', 'a1')
    await writeFile(outside, 'data')
    await mkdir(join(root, 'attachments', 'c1'), { recursive: true })
    await symlink(outside, path)
    const openPath = async () => ''

    await expect(openAttachment(root, 'c1', 'a1', openPath)).rejects.toThrow(/regular|symbolic/i)
  })

  it('surfaces a shell.openPath failure', async () => {
    const root = await rootDir()
    const path = resolveStoredAttachmentPath(root, 'c1', 'a1')
    await mkdir(join(root, 'attachments', 'c1'), { recursive: true })
    await writeFile(path, 'data')

    await expect(openAttachment(root, 'c1', 'a1', async () => 'No application')).rejects.toThrow(
      /No application/
    )
  })
})
