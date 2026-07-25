import { constants } from 'fs'
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile
} from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { saveVerifiedBytes, type AttachmentSaveDependencies } from './attachmentSave'

const temporaryDirectories: string[] = []

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'bearcode-attachment-save-'))
  temporaryDirectories.push(directory)
  return directory
}

async function temporarySiblings(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.endsWith('.bearcode-tmp'))
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('saveVerifiedBytes', () => {
  it('saves byte-identical content to a private new destination', async () => {
    const directory = await makeTemporaryDirectory()
    const destination = join(directory, 'report.bin')
    const bytes = Buffer.from([0, 255, 17, 99, 128])

    await saveVerifiedBytes(destination, bytes)

    expect(await readFile(destination)).toEqual(bytes)
    expect((await lstat(destination)).mode & 0o777).toBe(0o600)
    expect(await temporarySiblings(directory)).toEqual([])
  })

  it('keeps an existing destination unchanged until the atomic replacement', async () => {
    const directory = await makeTemporaryDirectory()
    const destination = join(directory, 'report.txt')
    const original = Buffer.from('original destination')
    const replacement = Buffer.from('complete verified replacement')
    await writeFile(destination, original)
    let contentBeforeRename: Buffer | undefined

    await saveVerifiedBytes(destination, replacement, {
      rename: async (source, target) => {
        contentBeforeRename = await readFile(target)
        await rename(source, target)
      }
    })

    expect(contentBeforeRename).toEqual(original)
    expect(await readFile(destination)).toEqual(replacement)
    expect((await lstat(destination)).mode & 0o777).toBe(0o600)
  })

  it('rejects a destination symlink without altering its target', async () => {
    const directory = await makeTemporaryDirectory()
    const target = join(directory, 'target.txt')
    const destination = join(directory, 'report.txt')
    const original = Buffer.from('do not replace through a link')
    await writeFile(target, original)
    await symlink(target, destination)

    await expect(
      saveVerifiedBytes(destination, Buffer.from('verified replacement'))
    ).rejects.toThrow('regular file')

    expect(await readFile(target)).toEqual(original)
    expect((await lstat(destination)).isSymbolicLink()).toBe(true)
    expect(await temporarySiblings(directory)).toEqual([])
  })

  it('retries a colliding temporary name without deleting the existing sibling', async () => {
    const directory = await makeTemporaryDirectory()
    const destination = join(directory, 'report.txt')
    const collision = join(directory, '.report.txt.collision.bearcode-tmp')
    await writeFile(collision, 'someone else owns this file')
    const randomNames = ['collision', 'available']

    await saveVerifiedBytes(destination, Buffer.from('verified bytes'), {
      randomName: () => randomNames.shift() ?? 'unexpected'
    })

    expect(await readFile(destination, 'utf8')).toBe('verified bytes')
    expect(await readFile(collision, 'utf8')).toBe('someone else owns this file')
    expect(await temporarySiblings(directory)).toEqual(['.report.txt.collision.bearcode-tmp'])
  })

  it('writes the complete buffer when the filesystem accepts short writes', async () => {
    const directory = await makeTemporaryDirectory()
    const destination = join(directory, 'report.bin')
    const bytes = Buffer.from('the whole immutable verified buffer')

    await saveVerifiedBytes(destination, bytes, {
      write: async (handle, buffer, offset, length) => {
        const result = await handle.write(buffer, offset, Math.min(length, 3), null)
        return result.bytesWritten
      }
    })

    expect(await readFile(destination)).toEqual(bytes)
  })

  it.each(['write', 'sync', 'rename'] as const)(
    'removes the private sibling and leaves no partial destination when %s fails',
    async (operation) => {
      const directory = await makeTemporaryDirectory()
      const destination = join(directory, 'report.bin')
      const dependencies: AttachmentSaveDependencies =
        operation === 'write'
          ? {
              write: async () => {
                throw new Error('injected write failure')
              }
            }
          : operation === 'sync'
            ? {
                sync: async () => {
                  throw new Error('injected sync failure')
                }
              }
            : {
                rename: async () => {
                  throw new Error('injected rename failure')
                }
              }

      await expect(
        saveVerifiedBytes(destination, Buffer.from('verified bytes'), dependencies)
      ).rejects.toThrow(`injected ${operation} failure`)

      await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await temporarySiblings(directory)).toEqual([])
    }
  )

  it('rejects a destination changed to a symlink after the temporary file is synced', async () => {
    const directory = await makeTemporaryDirectory()
    const target = join(directory, 'target.txt')
    const destination = join(directory, 'report.txt')
    const originalTarget = Buffer.from('target stays untouched')
    await writeFile(target, originalTarget)
    await writeFile(destination, 'original destination')

    await expect(
      saveVerifiedBytes(destination, Buffer.from('verified replacement'), {
        sync: async (handle) => {
          await handle.sync()
          await unlink(destination)
          await symlink(target, destination)
        }
      })
    ).rejects.toThrow('regular file')

    expect(await readFile(target)).toEqual(originalTarget)
    expect((await lstat(destination)).isSymbolicLink()).toBe(true)
    expect(await temporarySiblings(directory)).toEqual([])
  })

  it('creates the private sibling with exclusive no-follow flags and mode 0600', async () => {
    const directory = await makeTemporaryDirectory()
    const destination = join(directory, 'report.bin')
    let observedFlags = 0
    let observedMode = 0

    await saveVerifiedBytes(destination, Buffer.from('verified bytes'), {
      open: async (path, flags, mode) => {
        observedFlags = flags
        observedMode = mode
        return open(path, flags, mode)
      }
    })

    expect(observedFlags & constants.O_CREAT).toBe(constants.O_CREAT)
    expect(observedFlags & constants.O_EXCL).toBe(constants.O_EXCL)
    expect(observedFlags & constants.O_WRONLY).toBe(constants.O_WRONLY)
    expect(observedFlags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW)
    expect(observedMode).toBe(0o600)
  })
})
